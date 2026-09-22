describe("hubspotOwnersService — getConnectedOwnerByEmail", () => {
  const OWNERS = [
    { id: "1", name: "Alice", hubspotOwnerId: "ho-1", email: "alice@example.com" },
    { id: "2", name: "Bob", hubspotOwnerId: "ho-2", email: "bob@example.com" },
  ];

  beforeEach(() => {
    jest.resetModules();
  });

  // Fresh module instance per test (the service caches owners at module
  // scope), with its dependencies mocked before it's required.
  const loadServiceWithOwners = () => {
    jest.doMock("../../src/config/prisma", () => ({
      __esModule: true,
      default: { user: { findMany: jest.fn().mockResolvedValue(OWNERS) } },
    }));
    jest.doMock("../../src/services/hubspotOAuthService", () => ({
      HubSpotOAuthService: {
        getValidAccessToken: jest.fn().mockRejectedValue(new Error("no token")),
      },
    }));
    jest.doMock("../../src/services/hubspotHelpers", () => ({
      getOwnerById: jest.fn(),
    }));
    return require("../../src/services/hubspotOwnersService");
  };

  it("resolves an owner by exact email match", async () => {
    const { getConnectedOwnerByEmail } = loadServiceWithOwners();
    const owner = await getConnectedOwnerByEmail("alice@example.com");
    expect(owner?.id).toBe("1");
  });

  it("matches case-insensitively", async () => {
    const { getConnectedOwnerByEmail } = loadServiceWithOwners();
    const owner = await getConnectedOwnerByEmail("ALICE@EXAMPLE.COM");
    expect(owner?.id).toBe("1");
  });

  it("returns undefined for an unknown email", async () => {
    const { getConnectedOwnerByEmail } = loadServiceWithOwners();
    const owner = await getConnectedOwnerByEmail("nobody@example.com");
    expect(owner).toBeUndefined();
  });
});
