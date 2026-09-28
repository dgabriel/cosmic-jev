import { startExperience } from "./experience/sequencer";

const app = document.getElementById("app");
if (app === null) {
  throw new Error("Missing #app mount point in index.html");
}

void startExperience(app);
