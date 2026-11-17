// Detecta o ambiente local para encaminhar chamadas de IA para o servidor de desenvolvimento.
const localHosts = new Set(["127.0.0.1", "localhost"]);
const aiConfig = {
  apiBaseUrl: localHosts.has(window.location.hostname)
    ? "http://127.0.0.1:3000"
    : ""
};

export default aiConfig;
