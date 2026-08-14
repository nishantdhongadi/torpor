// Only the extension itself belongs in the .xpi. The dev scripts, tests and
// research notes stay in the repo.
const ignoreFiles = [
  "docs/**",
  "scripts/**",
  "test/**",
  "web-ext-config.mjs",
  "package.json",
  "package-lock.json",
  "README.md",
];

export default {
  ignoreFiles,
  lint: { warningsAsErrors: false },
  run: {
    firefox: "/Applications/Zen.app/Contents/MacOS/zen",
    startUrl: ["about:debugging#/runtime/this-firefox"],
  },
};
