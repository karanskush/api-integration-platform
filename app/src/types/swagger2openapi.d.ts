declare module 'swagger2openapi' {
  type ConvertOptions = {
    patch?: boolean;
    warnOnly?: boolean;
    resolve?: boolean;
    anchors?: boolean;
  };
  type ConvertResult = { openapi: Record<string, unknown> };
  const s2o: {
    convertObj(doc: Record<string, unknown>, options: ConvertOptions): Promise<ConvertResult>;
  };
  export default s2o;
}
