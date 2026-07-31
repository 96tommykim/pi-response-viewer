/* First-party explicit fence highlighter. Only the aliases below may select a Prism grammar. */
(() => {
  // Prism's automatic DOM scan would bypass this explicit-language allowlist.
  if (window.Prism) window.Prism.manual = true;
  const aliases = new Map([
    ["go", ["go", "Go"]],
    ["js", ["javascript", "JavaScript"]], ["javascript", ["javascript", "JavaScript"]],
    ["ts", ["typescript", "TypeScript"]], ["typescript", ["typescript", "TypeScript"]],
    ["python", ["python", "Python"]], ["py", ["python", "Python"]],
    ["bash", ["bash", "Bash"]], ["sh", ["bash", "Bash"]], ["shell", ["bash", "Bash"]],
    ["yaml", ["yaml", "YAML"]], ["yml", ["yaml", "YAML"]],
    ["json", ["json", "JSON"]], ["sql", ["sql", "SQL"]],
    ["hcl", ["hcl", "HCL"]], ["terraform", ["hcl", "HCL"]], ["tf", ["hcl", "HCL"]],
    ["docker", ["docker", "Dockerfile"]], ["dockerfile", ["docker", "Dockerfile"]],
    ["markdown", ["markdown", "Markdown"]], ["md", ["markdown", "Markdown"]],
  ]);
  const info = value => aliases.get(String(value || "").trim().toLocaleLowerCase()) || null;
  const languageFromCode = code => {
    const className = [...code.classList].find(name => name.startsWith("language-"));
    return info(className?.slice("language-".length));
  };
  const fragment = (text, language) => {
    const source = String(text || ""), grammar = language && window.Prism?.languages?.[language[0]];
    const template = document.createElement("template");
    if (!grammar) { template.content.append(document.createTextNode(source)); return template.content; }
    const clean = DOMPurify.sanitize(window.Prism.highlight(source, grammar, language[0]), {
      ALLOWED_TAGS: ["span"], ALLOWED_ATTR: ["class"], ALLOW_DATA_ATTR: false,
    });
    template.innerHTML = clean;
    return template.content;
  };
  window.ResponseViewerSyntax = { languageFromCode, highlight: fragment, canonical: language => language?.[1] || "Plain" };
})();
