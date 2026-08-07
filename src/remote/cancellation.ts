export class RemoteSetupCancelledError extends Error {
  public constructor() {
    super("ModelHop phone-link setup was cancelled.");
    this.name = "RemoteSetupCancelledError";
  }
}
