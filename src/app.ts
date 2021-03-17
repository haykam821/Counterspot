import Counterspot from ".";
import getConfig from "./utils/get-config";

const counterspot = new Counterspot(getConfig());
counterspot.launch();
