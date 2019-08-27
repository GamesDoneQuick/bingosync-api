/* eslint-disable @typescript-eslint/no-var-requires */
import { LocalStorage as LSType } from "node-localstorage";

let localStorage: LSType | Storage;
if (typeof window === "undefined") {
	const path = require("path");
	const LocalStorage: new (
		location: string,
		quota?: number,
	) => LSType = require("node-localstorage").LocalStorage;
	localStorage = new LocalStorage(path.join(__dirname, "localstorage"));
} else {
	localStorage = window.localStorage;
}

export default localStorage;
