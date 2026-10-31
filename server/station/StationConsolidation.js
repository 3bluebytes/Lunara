import { MemoryConsolidator } from '../memory/MemoryConsolidator.js';

// Local housekeeping only. Cross-person promotion belongs to StationDreamingService.
export function consolidateStation(stationMemoryService) {
  return new MemoryConsolidator(stationMemoryService, 'station').consolidateMemories();
}
