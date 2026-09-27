import { ORACLE_KIND } from "./config";

const app = document.getElementById("app");
if (app === null) {
  throw new Error("Missing #app mount point in index.html");
}

const heading = document.createElement("h1");
heading.textContent = "Cosmic Oracle";
app.append(heading);

app.dataset["oracle"] = ORACLE_KIND;
