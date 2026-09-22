// Regression test for Finding 1 (critical): the LinkedIn-accounts cache
// (laCache/laInFlight in publicController.ts) is a single process-global,
// unkeyed cache. It must always be warmed with the FULL connected-owner
// list, with per-requester scoping applied as a filter AFTER the cache
// read — never by passing a requester's scoped owner-id list into the
// cache-warming call itself, which would leak whichever requester's scope
// happened to warm the cache into every other requester's response.
//
// This test warms the cache via a "super_admin"-like unrestricted request
// (scopeOwnerIds: null, sees owners A and B), then immediately issues a
// second, differently-scoped request (scopeOwnerIds: ["A"]) and asserts
// the second response's linkedinAccounts/ownerAccounts contain ONLY
// owner A's data — proving the cache itself is shared/unkeyed but the
// controller still scopes correctly per requester.

describe("getFilters — LinkedIn-account cache is scoped per requester after the shared cache read", () => {
  const OWNER_A = { id: "owner-a", name: "Alice" };
  const OWNER_B = { id: "owner-b", name: "Bob" };

  // connectionRequest rows: owner A used LinkedIn account "acct-a", owner B
  // used LinkedIn account "acct-b". Distinct per (userId, actorLinkedinId).
  const CONNECTION_ROWS = [
    { userId: OWNER_A.id, actorLinkedinId: "acct-a", actorName: "Acct A" },
    { userId: OWNER_B.id, actorLinkedinId: "acct-b", actorName: "Acct B" },
  ];

  beforeEach(() => {
    jest.resetModules();
  });

  const loadControllerWithMocks = () => {
    jest.doMock("../../src/config/prisma", () => ({
      __esModule: true,
      default: {
        connectionRequest: {
          findMany: jest.fn().mockResolvedValue(CONNECTION_ROWS),
        },
        messageActivity: {
          findMany: jest.fn().mockResolvedValue([]),
        },
      },
    }));
    jest.doMock("../../src/services/hubspotOwnersService", () => ({
      getConnectedOwners: jest.fn().mockResolvedValue([OWNER_A, OWNER_B]),
      getConnectedOwnerIds: jest.fn().mockResolvedValue([OWNER_A.id, OWNER_B.id]),
      getConnectedOwnerNameMap: jest.fn().mockResolvedValue(new Map()),
    }));
    return require("../../src/controllers/publicController");
  };

  const runFilters = async (scopeOwnerIds: string[] | null) => {
    const { getFilters } = loadedController;
    let payload: any;
    const req: any = { scopeOwnerIds, query: {} };
    const res: any = {
      json: (body: any) => {
        payload = body;
      },
      status: () => res,
    };
    const next = jest.fn();
    await getFilters(req, res, next);
    expect(next).not.toHaveBeenCalled();
    return payload.data;
  };

  let loadedController: any;

  it("scopes accounts/pairs to the requester after an unrestricted request warmed the shared cache", async () => {
    loadedController = loadControllerWithMocks();

    // 1. Unrestricted ("super_admin") requester warms the shared cache with
    //    BOTH owners' data.
    const adminResult = await runFilters(null);
    expect(adminResult.linkedinAccounts.map((a: any) => a.id).sort()).toEqual([
      "acct-a",
      "acct-b",
    ]);
    expect(adminResult.ownerAccounts).toHaveLength(2);

    // 2. A differently-scoped requester (self-only, sees only owner A) hits
    //    the SAME warm cache immediately after. Before the fix, the cache
    //    would have been warmed with whichever owner list happened to call
    //    it first, leaking cross-scope data. After the fix, this requester
    //    must see ONLY owner A's account, regardless of what warmed the
    //    cache.
    const scopedResult = await runFilters([OWNER_A.id]);
    expect(scopedResult.linkedinAccounts.map((a: any) => a.id)).toEqual(["acct-a"]);
    expect(scopedResult.ownerAccounts).toEqual([
      { ownerId: OWNER_A.id, linkedinAccountId: "acct-a" },
    ]);
    expect(scopedResult.users.map((u: any) => u.id)).toEqual([OWNER_A.id]);
  });
});
