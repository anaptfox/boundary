import type { InvocationCoordinator } from "./coordination";
import type { InvocationObserver } from "./observation";
import { bindProjection } from "./binding";
import type { AdmissionRequest, BindResult, InteractionInstallation, Projection, ProjectionSelections } from "./types";
import type { MaybePromise } from "./types";

export type AuthorizedAdmissionDecision<AuthContext> = Readonly<{ decision: "allow"; context: AuthContext }> | Readonly<{ decision: "deny"; reason: string }>;
export type AuthorizedAdmission<CallerContext, AuthContext> = (request: AdmissionRequest<CallerContext>) => MaybePromise<AuthorizedAdmissionDecision<AuthContext>>;

export function bindAuthorizedProjection<const Selections extends ProjectionSelections, CallerContext, AuthContext>(
  projection: Projection<Selections>,
  installation: InteractionInstallation<AuthContext>,
  options: Readonly<{ admit: AuthorizedAdmission<CallerContext, AuthContext>; observation?: InvocationObserver<AuthContext>; coordinate?: InvocationCoordinator<AuthContext> }>,
): BindResult<Projection<Selections>["handles"], CallerContext> {
  const result = bindProjection(projection, installation as unknown as InteractionInstallation<CallerContext>, {
    admit: options.admit as unknown as import("./types").Admission<CallerContext>,
    observation: options.observation as unknown as InvocationObserver<CallerContext> | undefined,
    coordinate: options.coordinate as unknown as InvocationCoordinator<CallerContext> | undefined,
  });
  return result as unknown as BindResult<Projection<Selections>["handles"], CallerContext>;
}
