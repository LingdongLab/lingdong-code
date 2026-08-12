import crypto from "node:crypto";
import fs from "node:fs";
import pathMod from "node:path";

const path =
  process.argv[2] ||
  "E:/LingdongCode/desktop/VSCode-win32-x64-fresh/resources/app/out/vs/workbench/workbench.desktop.main.js";

let s = fs.readFileSync(path, "utf8");

const selectionBlock = `$dJ.appendMenuItem($bJ.MenubarMainMenu, {
  submenu: $bJ.MenubarSelectionMenu,
  title: {
    value: "Selection",
    original: "Selection",
    mnemonicTitle: localize(3747, null)
  },
  order: 3
});
`;

const goBlock = `$dJ.appendMenuItem($bJ.MenubarMainMenu, {
  submenu: $bJ.MenubarGoMenu,
  title: {
    value: "Go",
    original: "Go",
    mnemonicTitle: localize(3749, null)
  },
  order: 5
});
`;

const terminalBlock = `$dJ.appendMenuItem($bJ.MenubarMainMenu, {
  submenu: $bJ.MenubarTerminalMenu,
  title: {
    value: "Terminal",
    original: "Terminal",
    mnemonicTitle: localize(3750, null)
  },
  order: 7
});
`;

const runBlock = `$dJ.appendMenuItem($bJ.MenubarMainMenu, {
  submenu: $bJ.MenubarDebugMenu,
  title: {
    ...localize2(5730, "Run"),
    mnemonicTitle: localize(5649, null)
  },
  order: 6
});
`;

function strip(block, label) {
  if (s.includes(block)) {
    s = s.replace(block, `/* Lingdong: omit ${label} */\n`);
    console.log(`removed ${label}`);
    return;
  }
  const crlf = block.replace(/\n/g, "\r\n");
  if (s.includes(crlf)) {
    s = s.replace(crlf, `/* Lingdong: omit ${label} */\r\n`);
    console.log(`removed ${label} (CRLF)`);
    return;
  }
  throw new Error(`block not found: ${label}`);
}

strip(selectionBlock, "Selection");
strip(goBlock, "Go");
strip(terminalBlock, "Terminal");
strip(runBlock, "Run");

// Reorder remaining View/Help orders to match Cursor-ish 3/4.
s = s.replace(
  /submenu: \$bJ\.MenubarViewMenu,\n  title: \{\n    value: "View",\n    original: "View",\n    mnemonicTitle: localize\(3748, null\)\n  \},\n  order: 4/,
  `submenu: $bJ.MenubarViewMenu,
  title: {
    value: "View",
    original: "View",
    mnemonicTitle: localize(3748, null)
  },
  order: 3`,
);
s = s.replace(
  /submenu: \$bJ\.MenubarHelpMenu,\n  title: \{\n    value: "Help",\n    original: "Help",\n    mnemonicTitle: localize\(3751, null\)\n  \},\n  order: 8/,
  `submenu: $bJ.MenubarHelpMenu,
  title: {
    value: "Help",
    original: "Help",
    mnemonicTitle: localize(3751, null)
  },
  order: 4`,
);

fs.writeFileSync(path, s);
console.log("patched", path);

// Keep integrity check happy after hot-patching the bundled workbench.
const productPath = pathMod.resolve(pathMod.dirname(path), "../../product.json");
if (fs.existsSync(productPath)) {
  const product = JSON.parse(fs.readFileSync(productPath, "utf8"));
  if (product.checksums?.["vs/workbench/workbench.desktop.main.js"]) {
    const hash = crypto
      .createHash("sha256")
      .update(fs.readFileSync(path))
      .digest("base64")
      .replace(/=+$/, "");
    product.checksums["vs/workbench/workbench.desktop.main.js"] = hash;
    fs.writeFileSync(productPath, `${JSON.stringify(product, null, "\t")}\n`);
    console.log("updated checksum in", productPath);
  }
}
