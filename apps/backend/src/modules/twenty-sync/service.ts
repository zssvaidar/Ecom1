import { MedusaService } from "@medusajs/framework/utils"
import TwentySyncEvent from "./models/twenty-sync-event"

class TwentySyncModuleService extends MedusaService({
  TwentySyncEvent,
}) {}

export default TwentySyncModuleService
