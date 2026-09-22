// Runs before any test file (and before any module it imports) loads.
// src/config/env.ts throws at import time if JWT_SECRET is unset, and
// several services/controllers import it transitively.
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
