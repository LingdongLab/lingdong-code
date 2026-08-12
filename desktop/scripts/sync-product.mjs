/**
 * Merge desktop/product/product.lingdong.json into desktop/vscode/product.json (UTF-8 safe).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const productPath = path.join(desktopRoot, "vscode", "product.json");
const overlayPath = path.join(desktopRoot, "product", "product.lingdong.json");

if (!fs.existsSync(productPath)) {
  console.error("Missing", productPath, "- run setup-vscode.ps1 first");
  process.exit(1);
}

const base = JSON.parse(fs.readFileSync(productPath, "utf8"));
const overlay = JSON.parse(fs.readFileSync(overlayPath, "utf8"));
for (const [key, value] of Object.entries(overlay)) {
  if (key.startsWith("_")) continue;
  base[key] = value;
}
base.updateUrl = "";
base.releaseNotesUrl = "";

const text = JSON.stringify(base, null, "\t") + "\n";
fs.writeFileSync(productPath, text, "utf8");
fs.writeFileSync(path.join(desktopRoot, "product", "product.merged.snapshot.json"), text, "utf8");
JSON.parse(fs.readFileSync(productPath, "utf8"));
console.log("Merged branding into", productPath);
