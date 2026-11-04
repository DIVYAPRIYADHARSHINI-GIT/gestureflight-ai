/**
 * Minimal typings for occt-import-js (OpenCascade WASM STEP reader).
 *
 * The package ships no .d.ts, and only the ReadStepFile surface is used here.
 * Licence: LGPL-2.1 with the Open CASCADE exception — the .wasm is shipped
 * unmodified as a separate asset in /public/occt, with its licence texts.
 */
declare module "occt-import-js" {
  export interface OcctMeshAttribute {
    array: number[];
  }

  export interface OcctMesh {
    name?: string;
    color?: [number, number, number];
    attributes: {
      position: OcctMeshAttribute;
      normal?: OcctMeshAttribute;
    };
    index?: OcctMeshAttribute;
  }

  export interface OcctReadResult {
    success: boolean;
    root?: unknown;
    meshes?: OcctMesh[];
  }

  export interface OcctModule {
    ReadStepFile(buffer: Uint8Array, params: unknown): OcctReadResult;
    ReadIgesFile?(buffer: Uint8Array, params: unknown): OcctReadResult;
    ReadBrepFile?(buffer: Uint8Array, params: unknown): OcctReadResult;
  }

  export interface OcctFactoryOptions {
    locateFile?: (path: string) => string;
  }

  const factory: (options?: OcctFactoryOptions) => Promise<OcctModule>;
  export default factory;
}
