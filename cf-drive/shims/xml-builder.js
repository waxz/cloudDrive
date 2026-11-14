// The AWS SDK's browser build parses XML with DOMParser, which Workers don't
// have. wrangler.toml aliases @aws-sdk/xml-builder here so the SDK uses its
// self-contained parser instead.
export { XmlNode } from '../node_modules/@aws-sdk/xml-builder/dist-es/XmlNode.js';
export { XmlText } from '../node_modules/@aws-sdk/xml-builder/dist-es/XmlText.js';
export { parseXML } from '../node_modules/@aws-sdk/xml-builder/dist-es/xml-parser.js';
