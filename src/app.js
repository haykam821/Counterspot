const getConfig = require("./utils/get-config.js");
const config = getConfig();

const Counterspot = require(".");

const counterspot = new Counterspot(config);
counterspot.launch();