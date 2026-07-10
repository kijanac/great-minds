import type { DomainError } from "@great-minds/domain";

export type HttpErrorResponse = {
  readonly status: 401 | 403 | 404 | 422;
  readonly body: {
    readonly detail: string;
  };
};

export const domainErrorResponse = (error: DomainError): HttpErrorResponse => {
  switch (error._tag) {
    case "Unauthorized":
      return { status: 401, body: { detail: error.detail } };
    case "Forbidden":
      return { status: 403, body: { detail: error.detail } };
    case "NotFound":
      return { status: 404, body: { detail: error.detail } };
    case "Validation":
      return { status: 422, body: { detail: error.detail } };
  }
};
