import { Module } from "@medusajs/framework/utils"
import TwentySyncModuleService from "./service"

export const TWENTY_SYNC_MODULE = "twenty_sync"

export default Module(TWENTY_SYNC_MODULE, {
  service: TwentySyncModuleService,
})
