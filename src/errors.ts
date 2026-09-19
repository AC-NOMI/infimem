export class InfimemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends InfimemError {
  readonly issues: readonly unknown[];

  constructor(message: string, issues: readonly unknown[] = []) {
    super(message);
    this.issues = issues;
  }
}

export class NotFoundError extends InfimemError {}
