const { app } = require("electron");

// Development keeps readable sources. Packaged builds load only obfuscated,
// integrity-protected files from app.asar.
require(app.isPackaged ? "./main.release.cjs" : "./main.cjs");
