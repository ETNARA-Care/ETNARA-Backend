/**
 * Where a notification opens, by the audience the database resolved for this person
 * (app_push_resolve). Pure, so it is tested without a database. Never builds a path from
 * anything but ids that the person's own pages re-check with RLS when they load.
 */
export type PushAudience = "agency" | "caregiver" | "family" | "self" | "applicant";

export interface TargetInput {
  type: string;
  audience: PushAudience;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  shiftId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (v: string | null) => (v && UUID.test(v) ? v.toLowerCase() : null);

export function notificationTargetPath(n: TargetInput): string | null {
  const shift = id(n.shiftId);
  const entity = id(n.relatedEntityId);
  switch (n.audience) {
    case "agency":
      // 147: SmartMatch — la solicitud exacta en la revisión de la agencia.
      if (n.type === "SMARTMATCH_APPLICATION_SUBMITTED") return entity ? `/agency/smartmatch?application=${entity}` : "/agency/smartmatch";
      if (n.type === "NEW_INCIDENT") return entity && n.relatedEntityType === "incident" ? `/agency/incidents/${entity}` : "/agency";
      return shift ? `/agency/shifts/${shift}` : "/agency/shifts";
    case "caregiver":
      if (n.type === "SHIFT_UNASSIGNED") return "/caregiver/shifts";
      return shift ? `/caregiver/shifts/${shift}` : "/caregiver/shifts";
    case "applicant":
      // 147: quien se postuló (puede ser de otra agencia) ve sus propias solicitudes.
      return entity ? `/caregiver/smartmatch?tab=mine&application=${entity}` : "/caregiver/smartmatch?tab=mine";
    case "family":
      if (n.type === "NEW_CARE_EVENT") return "/family/activity";
      if (n.type === "NEW_MESSAGE") return entity && n.relatedEntityType === "message_thread" ? `/family/messages?thread=${entity}` : "/family/messages";
      return "/family";
    case "self":
      return null;
    default:
      return null;
  }
}
