/** sfo-deploy 的稳定、可分类错误。 */

export type DeploymentErrorCode =
  | "cancelled"
  | "configuration"
  | "planning"
  | "preflight"
  | "download"
  | "transport"
  | "execution";

export class DeploymentError extends Error {
  readonly code: DeploymentErrorCode;

  constructor(
    message: string,
    code: DeploymentErrorCode = "execution",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class CancelledError extends DeploymentError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "cancelled", options);
  }
}

export class ConfigurationError extends DeploymentError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "configuration", options);
  }
}

export class PlanningError extends DeploymentError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "planning", options);
  }
}

export class PreflightError extends DeploymentError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "preflight", options);
  }
}

export class DownloadError extends DeploymentError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "download", options);
  }
}

export class TransportError extends DeploymentError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "transport", options);
  }
}

export class ExecutionError extends DeploymentError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "execution", options);
  }
}
