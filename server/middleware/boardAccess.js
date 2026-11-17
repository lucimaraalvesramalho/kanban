const ALLOWED_ROLES = new Set(["OWNER", "EDITOR", "VIEWER"]);

export function requireBoardMember(firestore, allowedRoles = ALLOWED_ROLES) {
  // Confirma que o usuário pertence ao quadro e possui um dos papéis permitidos.
  return async (request, response, next) => {
    try {
      const boardRef = firestore.collection("boards").doc(request.boardId);
      const memberSnapshot = await boardRef
        .collection("members")
        .doc(request.user.uid)
        .get();

      if (!memberSnapshot.exists) {
        response.status(403).json({ error: "Você não tem acesso a este quadro." });
        return;
      }

      const member = memberSnapshot.data();
      if (
        member.userId !== request.user.uid ||
        member.boardId !== request.boardId ||
        !ALLOWED_ROLES.has(member.role) ||
        !allowedRoles.has(member.role)
      ) {
        response.status(403).json({ error: "Você não tem acesso a este quadro." });
        return;
      }

      const boardSnapshot = await boardRef.get();
      if (!boardSnapshot.exists) {
        response.status(404).json({ error: "O quadro não foi encontrado." });
        return;
      }

      request.board = boardSnapshot.data();
      request.boardMember = member;
      next();
    } catch (error) {
      next(error);
    }
  };
}
