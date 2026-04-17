// Audio asset modules — Metro resolves these as numeric asset IDs
declare module '*.m4a' {
  const value: number;
  export default value;
}
declare module '*.mp3' {
  const value: number;
  export default value;
}
declare module '*.wav' {
  const value: number;
  export default value;
}
declare module '*.aac' {
  const value: number;
  export default value;
}
