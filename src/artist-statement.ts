const app = document.getElementById("app");
if (app === null) {
  throw new Error("Missing #app mount point in artist-statement.html");
}

app.className = "app";

const container = document.createElement("div");
container.className = "artist-statement";

const heading = document.createElement("h1");
heading.textContent = "Artist Statement";

const paragraph = document.createElement("p");
paragraph.textContent = "[placeholder — real statement TBD]";

const backLink = document.createElement("a");
backLink.href = "index.html";
backLink.textContent = "Back to Cosmic JEV";

container.append(heading, paragraph, backLink);
app.append(container);
