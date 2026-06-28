import type { RouteDecision } from "../shared/policy-contract";

declare global {
  interface Window {
    metisPolicy?: {
      getSampleDecision: () => Promise<RouteDecision>;
    };
  }
}
