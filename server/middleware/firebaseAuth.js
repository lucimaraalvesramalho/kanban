export function requireFirebaseAuth(auth) {
  return async (request, response, next) => {
    const authorization = request.get("authorization") || "";
    const match = authorization.match(/^Bearer\s+(.+)$/i);

    if (!match) {
      response.status(401).json({ error: "Entre na sua conta para continuar." });
      return;
    }

    try {
      const decodedToken = await auth.verifyIdToken(match[1]);
      if (!decodedToken || typeof decodedToken.uid !== "string" || !decodedToken.uid) {
        response.status(401).json({ error: "Sessão inválida. Entre novamente." });
        return;
      }

      request.user = decodedToken;
      next();
    } catch {
      response.status(401).json({ error: "Sessão inválida ou expirada. Entre novamente." });
    }
  };
}
