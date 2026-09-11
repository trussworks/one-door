export function useApp() {
  return {
    metadata: {
      visitor: { visitorId: "probe", actorId: "probe" },
      actors: [],
      organizations: [],
    },
    announce: () => {},
  };
}
