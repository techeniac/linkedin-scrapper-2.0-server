describe("MessageOwnerResolverService.retryAmbiguous", () => {
  const ROWS = [
    { conversationKey: "c-resolves", scraperUserId: "s1" },
    { conversationKey: "c-still-ambiguous", scraperUserId: "s1" },
    { conversationKey: "c-overridden-meanwhile", scraperUserId: "s1" },
    { conversationKey: "c-no-scraper", scraperUserId: null },
  ];

  // Fresh module per test: the service keeps its throttle at module scope.
  const load = () => {
    jest.resetModules();
    const cache = {
      findRetryableAmbiguous: jest.fn().mockResolvedValue(ROWS),
      // c-overridden-meanwhile was flipped to 'manual' after the scan: guard says no.
      promoteAmbiguous: jest.fn(async (key: string) => key !== "c-overridden-meanwhile"),
    };
    const events = { updateResolvedOwner: jest.fn().mockResolvedValue(undefined) };
    jest.doMock("../../src/config/prisma", () => ({ __esModule: true, default: {} }));
    jest.doMock("../../src/utils/logger", () => ({
      __esModule: true,
      default: { info: jest.fn(), warn: jest.fn() },
    }));
    jest.doMock("../../src/repositories/conversationOwnerCacheRepository", () => ({
      ConversationOwnerCacheRepository: cache,
    }));
    jest.doMock("../../src/repositories/messageEventRepository", () => ({ MessageEventRepository: events }));
    jest.doMock("../../src/services/hubspotContextService", () => ({ HubSpotContextService: {} }));
    const { MessageOwnerResolverService: svc } = require("../../src/services/messageOwnerResolverService");
    const resolve = jest.fn(async (key: string) =>
      key === "c-still-ambiguous"
        ? { ownerId: null, source: "ambiguous", ambiguousReason: "NO_HUBSPOT_MATCH" }
        : { ownerId: "owner-1", source: "hubspot" },
    );
    svc.resolveOwnerFromHubSpot = resolve;
    return { svc, cache, events, resolve };
  };

  it("promotes only conversations HubSpot now resolves, and restamps just those", async () => {
    const { svc, cache, events, resolve } = load();

    const n = await svc.retryAmbiguous(new Date("2026-10-22T10:00:00Z"));

    expect(n).toBe(1);
    // no scraper -> never looked up; ambiguous result -> never promoted
    expect(resolve).toHaveBeenCalledTimes(3);
    expect(cache.promoteAmbiguous).toHaveBeenCalledTimes(2);
    expect(events.updateResolvedOwner).toHaveBeenCalledTimes(1);
    expect(events.updateResolvedOwner).toHaveBeenCalledWith("c-resolves", "owner-1", "hubspot");
  });

  it("only retries the self-fixing reasons, within the age window", async () => {
    const { svc, cache } = load();
    const now = new Date("2026-10-22T10:00:00Z");

    await svc.retryAmbiguous(now);

    expect(cache.findRetryableAmbiguous).toHaveBeenCalledWith({
      reasons: ["NO_HUBSPOT_MATCH", "OWNER_NOT_CONNECTED"],
      olderThan: new Date("2026-10-22T09:55:00Z"),
      newerThan: new Date("2026-10-21T10:00:00Z"),
      limit: 20,
    });
  });

  it("is throttled: a second call inside the window does no work", async () => {
    const { svc, cache } = load();
    const now = new Date("2026-10-22T10:00:00Z");

    await svc.retryAmbiguous(now);
    const again = await svc.retryAmbiguous(new Date(now.getTime() + 60_000));

    expect(again).toBe(0);
    expect(cache.findRetryableAmbiguous).toHaveBeenCalledTimes(1);
  });
});
