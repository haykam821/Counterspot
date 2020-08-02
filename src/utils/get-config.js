const { cosmiconfigSync: cosmic } = require("cosmiconfig");
const mergeDeep = require("merge-deep");

const { configuration: log } = require("./debug.js");

const baseConfig = {
	blacklist: [],
	cachePath: "./cache.json",
	count: {
		amount: 1,
		channel: "",
		direction: 1,
	},
	report: {
		addReaction: true,
		deletionTimeout: 5000,
		showAuthor: false,
		showTimestamp: true,
	},
	token: "",
};

/**
 * Gets the user-defined configuration with default values.
 * @returns {Object} The configuration object.
 */
function getConfig() {
	const explorer = cosmic("counterspot", {
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

	log("loaded configuration from '%s'", result.filepath);
	log("loaded configuration: %O", result.config);

	return result.config;
}
module.exports = getConfig;