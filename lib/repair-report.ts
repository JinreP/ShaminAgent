import { z } from "zod";

export const repairReportSchema = z.object({
  vehicle: z.string().trim().max(200),
  parts: z.string().trim().max(2000),
  tasks: z.string().trim().max(2000),
  warnings: z.array(z.string().trim().max(500)).max(10),
});

export type RepairReport = z.infer<typeof repairReportSchema>;
