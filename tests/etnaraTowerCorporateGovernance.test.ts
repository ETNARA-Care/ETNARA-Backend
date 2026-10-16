import { describe, expect, it } from "vitest";
import { CORPORATE_TASK_EXECUTION_ENABLED, mayTransitionCorporateTask, validateCorporateTaskRequest } from "../src/modules/etnaraTower/corporateTaskPolicy.js";
import { TOWER_CORPORATE_AGENTS, TOWER_CORPORATE_DEPARTMENTS } from "../src/modules/etnaraTower/corporateRoster.js";

describe("ETNARA Tower corporate governance", () => {
  it("defines 26 distinct roles in eight departments", () => {
    expect(TOWER_CORPORATE_AGENTS).toHaveLength(26);
    expect(TOWER_CORPORATE_DEPARTMENTS).toHaveLength(8);
    expect(new Set(TOWER_CORPORATE_AGENTS.map(agent => agent.id)).size).toBe(26);
    expect(TOWER_CORPORATE_AGENTS.every(agent => TOWER_CORPORATE_DEPARTMENTS.some(dept => dept.id === agent.department))).toBe(true);
  });
  it("rejects invalid tasks and unknown agents", () => {
    expect(validateCorporateTaskRequest({agentId:"unknown",title:"Valid task",instructions:"Prepare a plan",priority:"normal"})).toBe(false);
    expect(validateCorporateTaskRequest({agentId:"secretariat-1",title:"Prepare agenda",instructions:"Draft next meeting agenda",priority:"normal"})).toBe(true);
  });
  it("requires admin approval and does not enable execution", () => {
    expect(mayTransitionCorporateTask({from:"in_review",to:"approved",approvedByPlatformAdmin:false})).toBe(false);
    expect(mayTransitionCorporateTask({from:"in_review",to:"approved",approvedByPlatformAdmin:true})).toBe(true);
    expect(mayTransitionCorporateTask({from:"draft",to:"completed",approvedByPlatformAdmin:true})).toBe(false);
    expect(CORPORATE_TASK_EXECUTION_ENABLED).toBe(false);
  });
});
