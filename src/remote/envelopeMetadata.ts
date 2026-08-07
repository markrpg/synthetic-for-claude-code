export function remoteEnvelopeAdditionalData(
  version: string,
  connectionId: string,
  sequence: number,
): string {
  return `${version}\n${connectionId}\n${sequence}`;
}
