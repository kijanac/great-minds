import { Uuid } from "@great-minds/domain";

export const newUuid = (): Uuid => Uuid.make(crypto.randomUUID(), { disableChecks: true });
