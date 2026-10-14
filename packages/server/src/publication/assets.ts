import { basename } from "node:path";
import { fileURLToPath } from "node:url";

export const publicationFonts = fileURLToPath(
  new URL("../../assets/publication-fonts/", import.meta.url),
);
const fontSource =
  "https://raw.githubusercontent.com/google/fonts/66928797f271fed5ee428544e7229685e2d90127/ofl/";
const googleFont = (path: string, sha256: string) => ({
  name: path.endsWith("/OFL.txt") ? path.replace("/", "-") : basename(path),
  url: new URL(path.split("/").map(encodeURIComponent).join("/"), fontSource),
  sha256,
});
const dejavuFont = (name: string, sha256: string) => ({
  name: name === "LICENSE.txt" ? "dejavu-LICENSE.txt" : name,
  url: new URL(`../../assets/dejavu/${name}`, import.meta.url),
  sha256,
});
export const fontAssets = [
  googleFont(
    "librebaskerville/LibreBaskerville[wght].ttf",
    "05a95421961341c5b2556285e8415df9db27dab4f4abe22b446b3c6a8b916c5d",
  ),
  googleFont(
    "librebaskerville/LibreBaskerville-Italic[wght].ttf",
    "223959683dc73ec4437bd61fabaa4b3f22209e22855ffd3aee36ba61a5116e97",
  ),
  googleFont(
    "jetbrainsmono/JetBrainsMono[wght].ttf",
    "48715a42ec242c21e9f02692891e147d022299a52e48d5e413e1a942193ffeda",
  ),
  googleFont(
    "jetbrainsmono/JetBrainsMono-Italic[wght].ttf",
    "85ae2a5cd3f56baf1ce1c21a851322c58e3d8fbe8e8ad4a4d090a820dd7fe558",
  ),
  googleFont(
    "notosanssc/NotoSansSC[wght].ttf",
    "a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da",
  ),
  googleFont(
    "librebaskerville/OFL.txt",
    "3624eddd4c8f8a908130a417ae7cd089c9da69899c4e0ca1a5217d0a6fae16fd",
  ),
  googleFont(
    "jetbrainsmono/OFL.txt",
    "b2fe5e8987594e9ffd1d2ca52a2f5d73eb8335243893c5d6254b5ad69269591d",
  ),
  googleFont(
    "notosanssc/OFL.txt",
    "1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9",
  ),
  dejavuFont("DejaVuSans.ttf", "b4c632e3cdf9acc7f28758fb5a323c8524d7fc6660d46904d9b6cbe2809c419c"),
  dejavuFont("DejaVuSerif.ttf", "a52c2a69dfc93d0b511b98c1019a57eb3d6a62d328bdf1387f00851b02e3a315"),
  dejavuFont("LICENSE.txt", "63d3ba759d12804c5b31a9d5940d855c1820d1f5999e6b0872eb1c7ff045fbc9"),
] as const;
