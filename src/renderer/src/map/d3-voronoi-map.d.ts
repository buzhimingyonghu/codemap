// Minimal typings for the parts of d3-voronoi-map the map layout uses.
declare module 'd3-voronoi-map' {
  export type VoronoiPoint = [number, number]

  export interface VoronoiMapPolygon<T> extends Array<VoronoiPoint> {
    site: { originalObject: { data: { originalData: T } } }
  }

  export interface VoronoiMapState<T> {
    ended: boolean
    iterationCount: number
    convergenceRatio: number
    polygons: VoronoiMapPolygon<T>[]
  }

  export interface VoronoiMapSimulation<T> {
    clip(): VoronoiPoint[]
    clip(polygon: VoronoiPoint[]): VoronoiMapSimulation<T>
    weight(accessor: (datum: T) => number): VoronoiMapSimulation<T>
    convergenceRatio(ratio: number): VoronoiMapSimulation<T>
    maxIterationCount(count: number): VoronoiMapSimulation<T>
    minWeightRatio(ratio: number): VoronoiMapSimulation<T>
    prng(random: () => number): VoronoiMapSimulation<T>
    initialPosition(accessor: (datum: T, index: number, data: T[], simulation: VoronoiMapSimulation<T>) => VoronoiPoint): VoronoiMapSimulation<T>
    stop(): VoronoiMapSimulation<T>
    tick(): void
    state(): VoronoiMapState<T>
  }

  export function voronoiMapSimulation<T>(data: T[]): VoronoiMapSimulation<T>
}
