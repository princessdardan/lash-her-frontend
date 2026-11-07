export class ApiContractError extends Error {
  constructor() {
    super("Upstream response does not match the pinned API contract");
    this.name = "ApiContractError";
  }
}
