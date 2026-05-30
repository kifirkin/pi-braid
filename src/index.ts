import { join } from "path";
import { fileURLToPath } from "url";

const _skillsUrl = new URL(".", import.meta.url);
export const SKILLS_DIR = join(fileURLToPath(_skillsUrl), "..", "skills");
