import { mkdir, writeFile } from 'node:fs/promises';
import Pokedex from 'pokedex-promise-v2';
import type { Pokemon, Shape, Type } from '../src/lib/types/Pokemon';
import { createProgressBar, limitedConcurrency } from './concurrency';

const pokemonApi = new Pokedex({ timeout: 60_000 });

const WORKERS = 3;
const BATCH_SIZE = 50;
const MAX_FETCH_ATTEMPTS = 5;
const RETRY_DELAY_MS = 1_000;
const RAW_SPRITES_PREFIX = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/';

const GAME_NAME_OVERRIDES: Record<string, string> = {
	heartgold: 'HeartGold',
	soulsilver: 'SoulSilver',
	firered: 'FireRed',
	leafgreen: 'LeafGreen'
};

const REGIONAL_PREFIXES = {
	alola: 'Alolan',
	galar: 'Galarian',
	hisui: 'Hisuian',
	paldea: 'Paldean'
} as const;

const COSMETIC_SPECIES = new Set([
	'alcremie',
	'eevee',
	'flabebe',
	'floette',
	'florges',
	'furfrou',
	'minior',
	'pikachu',
	'squawkabilly',
	'unown',
	'vivillon'
]);

const COSMETIC_SUFFIXES = ['-cap', '-cosplay', '-totem'];

type Region = keyof typeof REGIONAL_PREFIXES;

function toTitleCase(value: string): string {
	return value
		.split('-')
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(' ');
}

function toArray<T>(value: T | T[]): T[] {
	return Array.isArray(value) ? value : [value];
}

function toBatches<T>(items: readonly T[], batchSize: number): T[][] {
	const batches: T[][] = [];

	for (let index = 0; index < items.length; index += batchSize) {
		batches.push(items.slice(index, index + batchSize));
	}

	return batches;
}

function isRetryableRequestError(error: unknown): boolean {
	if (!error || typeof error !== 'object') return false;

	const requestError = error as { code?: string; response?: { status?: number } };
	const status = requestError.response?.status;

	return (
		status === 429 ||
		(status !== undefined && status >= 500) ||
		['ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT', 'ERR_NETWORK'].includes(requestError.code ?? '')
	);
}

async function withRetries<T>(label: string, fn: () => Promise<T>): Promise<T> {
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await fn();
		} catch (error) {
			if (attempt >= MAX_FETCH_ATTEMPTS || !isRetryableRequestError(error)) throw error;

			const delay = RETRY_DELAY_MS * 2 ** (attempt - 1);
			console.warn(
				`\n${label} failed; retrying in ${delay / 1_000}s (${attempt}/${MAX_FETCH_ATTEMPTS})`
			);
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}
}

async function fetchBatched<T, R>(
	label: string,
	items: readonly T[],
	fn: (batch: T[]) => Promise<R[]>
): Promise<R[]> {
	const progress = createProgressBar(label, items.length);
	const batches = toBatches(items, BATCH_SIZE);
	let completed = 0;

	const results = await limitedConcurrency(
		batches,
		Math.min(WORKERS, batches.length),
		async (batch) => {
			const batchResults = await withRetries(`${label} batch`, () => fn(batch));

			completed += batch.length;
			progress(completed);

			return batchResults;
		}
	);

	return results.flat();
}

function getIdFromUrl(url: string): string {
	const id = url.split('/').at(-2);
	if (!id) throw new Error(`Could not get id from URL: ${url}`);
	return id;
}

function toLocalSpriteUrl(spriteUrl?: string | null): string | undefined {
	if (!spriteUrl) return undefined;

	return spriteUrl.startsWith(RAW_SPRITES_PREFIX)
		? spriteUrl.slice(RAW_SPRITES_PREFIX.length)
		: spriteUrl;
}

function getSprite(pokemon?: Pokedex.Pokemon): string | undefined {
	return toLocalSpriteUrl(pokemon?.sprites.front_default);
}

function getFemaleSprite(pokemon?: Pokedex.Pokemon): string | undefined {
	return toLocalSpriteUrl(pokemon?.sprites.front_female);
}

function toGenderNeutralFormName(name: string): string {
	return name.replace(/-(male|female)(?=-|$)/g, '');
}

function toDisplayPokemonName(name: string): string {
	if (name.endsWith('-gmax')) {
		return `G-Max ${toTitleCase(name.replace(/-gmax$/, ''))}`;
	}

	const megaMatch = name.match(/^(.+)-mega(?:-(.+))?$/);

	if (megaMatch) {
		const [, baseName, formName] = megaMatch;
		return ['Mega', toTitleCase(baseName), formName && toTitleCase(formName)]
			.filter(Boolean)
			.join(' ');
	}

	const region = (Object.keys(REGIONAL_PREFIXES) as Region[]).find((region) =>
		name.includes(`-${region}`)
	);

	if (!region) return toTitleCase(name);

	const marker = `-${region}`;
	const markerIndex = name.indexOf(marker);
	const baseName = name.slice(0, markerIndex);
	const formName = name.slice(markerIndex + marker.length + 1);
	const prefix = REGIONAL_PREFIXES[region];

	return formName
		? `${prefix} ${toTitleCase(baseName)} (${toTitleCase(formName)})`
		: `${prefix} ${toTitleCase(baseName)}`;
}

function formatGameName(name: string): string {
	const normalizedName = name.replace(/-(japan|korea|asia|europe|america)$/, '');

	return GAME_NAME_OVERRIDES[normalizedName] ?? toTitleCase(normalizedName);
}

function formatGamePair(names: string[]): string {
	return names.map(formatGameName).join(' & ');
}

async function getAllSpecies(): Promise<Pokedex.NamedAPIResource[]> {
	const firstPage = (await withRetries('Fetching species count', () =>
		pokemonApi.getPokemonSpeciesList({ offset: 0, limit: 1 })
	)) as Pokedex.NamedAPIResourceList;

	const allSpecies = (await withRetries('Fetching species list', () =>
		pokemonApi.getPokemonSpeciesList({ offset: 0, limit: firstPage.count })
	)) as Pokedex.NamedAPIResourceList;

	return allSpecies.results;
}

function getPrimaryFormId(pokemon: Pokedex.Pokemon): string {
	const formUrl = pokemon.forms[0]?.url;

	if (!formUrl) {
		throw new Error(`No forms found for Pokémon: ${pokemon.name}`);
	}

	return getIdFromUrl(formUrl);
}

function toPokemonType(entry: Pokedex.Pokemon['types'][number]): Type {
	const id = getIdFromUrl(entry.type.url);

	return {
		id,
		name: entry.type.name
	};
}

function uniqueVarieties(varieties: Pokedex.Variety[]): Pokedex.Variety[] {
	const seen = new Set<string>();

	return varieties.filter((variety) => {
		const id = getIdFromUrl(variety.pokemon.url);

		if (seen.has(id)) return false;

		seen.add(id);
		return true;
	});
}

async function getPokemonById(varieties: Pokedex.Variety[]): Promise<Map<string, Pokedex.Pokemon>> {
	const ids = uniqueVarieties(varieties).map((variety) =>
		Number(getIdFromUrl(variety.pokemon.url))
	);

	const pokemon = await fetchBatched('Fetching Pokémon', ids, async (batch) => {
		const result = (await pokemonApi.getPokemonByName(batch)) as
			Pokedex.Pokemon | Pokedex.Pokemon[];

		return toArray(result);
	});

	return new Map(pokemon.map((entry) => [String(entry.id), entry]));
}

async function getGenerationByPokemonId(
	pokemonById: Map<string, Pokedex.Pokemon>
): Promise<Map<string, { id: number; name: string }>> {
	const formIds = [
		...new Set([...pokemonById.values()].map((pokemon) => Number(getPrimaryFormId(pokemon))))
	];

	const forms = await fetchBatched('Fetching forms', formIds, async (batch) => {
		const result = (await pokemonApi.getPokemonFormByName(batch)) as
			Pokedex.PokemonForm | Pokedex.PokemonForm[];

		return toArray(result);
	});

	const formById = new Map(forms.map((form) => [String(form.id), form]));
	const versionGroupNames = [...new Set(forms.map((form) => form.version_group.name))];

	const versionGroups = await fetchBatched(
		'Fetching version groups',
		versionGroupNames,
		async (batch) => {
			const result = (await pokemonApi.getVersionGroupByName(batch)) as
				Pokedex.VersionGroup | Pokedex.VersionGroup[];

			return toArray(result);
		}
	);

	const versionGroupByName = new Map(versionGroups.map((entry) => [entry.name, entry]));
	const generationByPokemonId = new Map<string, { id: number; name: string }>();

	for (const [pokemonId, pokemon] of pokemonById) {
		const form = formById.get(getPrimaryFormId(pokemon));

		if (!form) {
			throw new Error(`No form found for Pokémon: ${pokemon.name}`);
		}

		const versionGroup = versionGroupByName.get(form.version_group.name);

		if (!versionGroup) {
			throw new Error(`No version group found for form: ${form.name}`);
		}

		generationByPokemonId.set(pokemonId, {
			id: Number(getIdFromUrl(versionGroup.generation.url)),
			name: formatGamePair(versionGroup.versions.map((version) => version.name))
		});
	}

	return generationByPokemonId;
}

function hasSameTyping(first: Pokemon, second: Pokemon): boolean {
	return first.type1.id === second.type1.id && first.type2?.id === second.type2?.id;
}

function hasDistinctGuessProperties(defaultPokemon: Pokemon, pokemon: Pokemon): boolean {
	return (
		defaultPokemon.gen.id !== pokemon.gen.id ||
		defaultPokemon.height !== pokemon.height ||
		defaultPokemon.weight !== pokemon.weight ||
		!hasSameTyping(defaultPokemon, pokemon)
	);
}

function isMegaForm(name: string): boolean {
	return name.includes('-mega');
}

function isAlwaysIncludedForm(name: string): boolean {
	return isMegaForm(name) || name.endsWith('-gmax');
}

function isCosmeticForm(speciesName: string, formName: string): boolean {
	return (
		COSMETIC_SPECIES.has(speciesName) ||
		COSMETIC_SUFFIXES.some((suffix) => formName.includes(suffix))
	);
}

type BuiltVariety = {
	name: string;
	pokemon: Pokemon;
	isDefault: boolean;
};

function getRegionalParent(
	variety: BuiltVariety,
	varieties: BuiltVariety[],
	speciesName: string
): BuiltVariety | undefined {
	const regions = Object.keys(REGIONAL_PREFIXES) as Region[];
	const region = regions.find((region) => variety.name.split('-').includes(region));
	const regionalParents = regions
		.map((region) => varieties.find((candidate) => candidate.name === `${speciesName}-${region}`))
		.filter((candidate): candidate is BuiltVariety => Boolean(candidate));

	if (region) {
		const parentName = `${speciesName}-${region}`;
		return variety.name === parentName
			? undefined
			: regionalParents.find((candidate) => candidate.name === parentName);
	}

	if (!variety.name.includes('-totem')) return undefined;

	return regionalParents.find(
		(candidate) =>
			candidate.pokemon.gen.id === variety.pokemon.gen.id &&
			hasSameTyping(candidate.pokemon, variety.pokemon)
	);
}

function getEquivalentMegaParent(
	variety: BuiltVariety,
	varieties: BuiltVariety[]
): BuiltVariety | undefined {
	if (!isMegaForm(variety.name)) return undefined;

	const parent = varieties.find(
		(candidate) =>
			isMegaForm(candidate.name) && !hasDistinctGuessProperties(candidate.pokemon, variety.pokemon)
	);

	return parent === variety ? undefined : parent;
}

function toReadableAllCapsWord(value: string): string {
	const lower = value.toLocaleLowerCase('en-US');
	return lower.charAt(0).toLocaleUpperCase('en-US') + lower.slice(1);
}

function getFlavorText(species: Pokedex.PokemonSpecies): string | undefined {
	const entry = species.flavor_text_entries.find((entry) => entry.language.name === 'en');
	if (!entry) return undefined;

	return entry.flavor_text
		.replace(/\f/g, ' ')
		.replace(/\n/g, ' ')
		.replace(/\u00ad\s*/g, '')
		.replace(/\s+/g, ' ')
		.replace(/\bpok[eé]mon\b/gi, 'Pokémon')
		.replace(/\b\p{Lu}[\p{Lu}'’.-]+\b/gu, toReadableAllCapsWord)
		.trim();
}

function getPokemonShape(species: Pokedex.PokemonSpecies): Shape {
	const id = getIdFromUrl(species.shape.url);

	return {
		id,
		name: species.shape.name,
		sprite: `sprites/shapes/Body${id.padStart(2, '0')}.png`
	};
}

function toPokemon(
	species: Pokedex.PokemonSpecies,
	variety: Pokedex.Variety,
	pokemonById: Map<string, Pokedex.Pokemon>,
	generationByPokemonId: Map<string, { id: number; name: string }>
): Pokemon | undefined {
	const id = getIdFromUrl(variety.pokemon.url);
	const pokemon = pokemonById.get(id);
	const sprite = getSprite(pokemon);
	const gen = generationByPokemonId.get(id);

	if (!pokemon || !sprite || !gen) return undefined;

	const neutralFormName = toGenderNeutralFormName(variety.pokemon.name);
	const name = toDisplayPokemonName(neutralFormName);
	const types = [...pokemon.types].sort((a, b) => a.slot - b.slot).map(toPokemonType);
	const hasExplicitFemaleVariety = species.varieties.some(
		(entry) =>
			entry.pokemon.name.includes('-female') &&
			toGenderNeutralFormName(entry.pokemon.name) === neutralFormName
	);
	const femaleSprite = hasExplicitFemaleVariety ? undefined : getFemaleSprite(pokemon);

	return {
		id,
		name,
		searchName: name.toLowerCase(),
		sprite,
		altSprites: femaleSprite && femaleSprite !== sprite ? [sprite, femaleSprite] : undefined,
		flavorText: getFlavorText(species),
		gen,
		height: pokemon.height / 10,
		weight: pokemon.weight / 10,
		type1: types[0],
		type2: types[1],
		shape: getPokemonShape(species)
	};
}

async function main(): Promise<void> {
	const speciesList = await getAllSpecies();

	const species = await fetchBatched('Fetching species', speciesList, async (batch) => {
		const result = (await pokemonApi.getPokemonSpeciesByName(batch.map(({ name }) => name))) as
			Pokedex.PokemonSpecies | Pokedex.PokemonSpecies[];

		return toArray(result);
	});

	const allVarieties = species.flatMap((entry) => entry.varieties);

	const pokemonById = await getPokemonById(allVarieties);
	const generationByPokemonId = await getGenerationByPokemonId(pokemonById);
	const buildProgress = createProgressBar('Building Pokémon', allVarieties.length);
	let completed = 0;

	const pokemon = species.flatMap((entry) => {
		const varieties = entry.varieties
			.map((variety) => {
				buildProgress(++completed);

				const pokemon = toPokemon(entry, variety, pokemonById, generationByPokemonId);
				return (
					pokemon && {
						name: variety.pokemon.name,
						pokemon,
						isDefault: variety.is_default
					}
				);
			})
			.filter((entry): entry is BuiltVariety => Boolean(entry));
		const defaultPokemon = varieties.find((entry) => entry.isDefault)?.pokemon;

		if (!defaultPokemon) return [];

		const included = new Set([defaultPokemon.id]);
		const altSpritesByPokemonId = new Map<string, string[]>();

		for (const variety of varieties.filter((entry) => !entry.isDefault)) {
			const equivalentMegaParent = getEquivalentMegaParent(variety, varieties);

			if (equivalentMegaParent) {
				const altSprites = altSpritesByPokemonId.get(equivalentMegaParent.pokemon.id) ?? [];
				altSprites.push(variety.pokemon.sprite);
				altSpritesByPokemonId.set(equivalentMegaParent.pokemon.id, altSprites);
				continue;
			}

			const regionalParent = getRegionalParent(variety, varieties, entry.name);

			if (
				isAlwaysIncludedForm(variety.name) ||
				(!regionalParent &&
					!isCosmeticForm(entry.name, variety.name) &&
					hasDistinctGuessProperties(defaultPokemon, variety.pokemon))
			) {
				included.add(variety.pokemon.id);
				continue;
			}

			const parent = regionalParent?.pokemon ?? defaultPokemon;
			const altSprites = altSpritesByPokemonId.get(parent.id) ?? [];
			altSprites.push(variety.pokemon.sprite);
			altSpritesByPokemonId.set(parent.id, altSprites);
		}

		return varieties
			.filter((variety) => included.has(variety.pokemon.id))
			.map(({ pokemon }) => {
				const altSprites = [
					...(pokemon.altSprites?.slice(1) ?? []),
					...(altSpritesByPokemonId.get(pokemon.id) ?? [])
				].filter((sprite, index, sprites) => sprites.indexOf(sprite) === index);

				return altSprites.length > 0
					? { ...pokemon, altSprites: [pokemon.sprite, ...altSprites] }
					: pokemon;
			});
	});

	await mkdir('.generated', { recursive: true });
	await writeFile('.generated/pokemon.json', JSON.stringify(pokemon, null, 2));
}

await main();
