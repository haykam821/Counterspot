import { Snowflake } from "discord.js";
import { configurationLog } from "./debug";
import { cosmiconfigSync } from "cosmiconfig";
import mergeDeep from "merge-deep";

export enum CountDirection {
	NEGATIVE = -1,
	POSITIVE = 1,
}

interface CountConfig {
	amount: number;
	channel: Snowflake;
	/**
	 * A specific count direction, or any other number for any direction.
	 */
	direction: CountDirection | number;
	multipleBySameUser: boolean;
}

interface GoalRolesConfig {
	achiever: Snowflake;
	assistant: Snowflake;
}

interface GoalConfig {
	announce: boolean;
	multiple: number;
	pin: boolean;
	reset: boolean;
	resetValue: number;
	roles: GoalRolesConfig;
	trackStatistics: boolean;
}

interface ReportLogConfig {
	channel: Snowflake;
	showAdditionalFields: boolean;
}

interface ReportConfig {
	addReaction: boolean;
	deletionTimeout: number;
	log: ReportLogConfig;
	showAuthor: boolean;
	showTimestamp: boolean;
}

export interface CounterspotConfig {
	blacklist: Snowflake[];
	cachePath: string;
	channel: Snowflake;
	count: CountConfig;
	goal: GoalConfig;
	report: ReportConfig;
	token: string;
}

const baseConfig: CounterspotConfig = {
	blacklist: [],
	cachePath: "./cache.json",
	channel: "",
	count: {
		amount: 1,
		channel: "",
		direction: 1,
		multipleBySameUser: false,
	},
	goal: {
		announce: true,
		multiple: 100,
		pin: true,
		reset: false,
		resetValue: 0,
		roles: {
			achiever: "",
			assistant: "",
		},
		trackStatistics: true,
	},
	report: {
		addReaction: true,
		deletionTimeout: 5000,
		log: {
			channel: "",
			showAdditionalFields: true,
		},
		showAuthor: false,
		showTimestamp: true,
	},
	token: "",
};

/**
 * Gets the user-defined configuration with default values.
 * @returns The configuration object.
 */
export default function getConfig(): CounterspotConfig {
	const explorer = cosmiconfigSync("counterspot", {
		searchPlaces: [
			"package.json",
			"config.json",
			".counterspotrc",
			".counterspotrc.json",
			".counterspotrc.yaml",
			".counterspotrc.yml",
			".counterspotrc.js",
			"counterspot.config.js",
		],
	});

	const result = mergeDeep({
		config: baseConfig,
	}, explorer.search());

	configurationLog("loaded configuration from '%s'", result.filepath);
	configurationLog("loaded configuration: %O", result.config);

	return result.config;
}
