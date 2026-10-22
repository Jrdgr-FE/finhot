import { copyFile, mkdir } from "node:fs/promises";
const root = new URL("../../", import.meta.url);
await mkdir(new URL("deploy/free/public/", root), { recursive: true });
for (const [source, target] of [["industry/brand/logo.svg", "logo.svg"], ["industry/brand/icon.png", "icon.png"], ["industry/pages/free-terms.md", "terms.txt"], ["industry/pages/free-privacy.md", "privacy.txt"]]) {
  await copyFile(new URL(source!, root), new URL(`deploy/free/public/${target}`, root));
}
console.log("FinHot free assets prepared.");
