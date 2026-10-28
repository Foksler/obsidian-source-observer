export interface Position {
    line: number;
    character: number;
}
export interface Range {
    start: Position;
    end: Position;
}
export interface LspLocation {
    uri: string;
    range: Range;
}
export interface LspSymbol {
    name: string;
    kind: number;
    uri: string;
    range: Range;
    selectionRange?: Range;
    detail?: string;
    containerName?: string;
    children?: LspSymbol[];
}
export interface DocumentSymbol {
    name: string;
    kind: number;
    range: Range;
    selectionRange: Range;
    detail?: string;
    children?: DocumentSymbol[];
}
export interface SymbolInformation {
    name: string;
    kind: number;
    location: LspLocation;
    containerName?: string;
}
/** Convert either flat workspace symbols or hierarchical document symbols. */
export function toLspSymbols(response: DocumentSymbol[] | SymbolInformation[] | null, fallbackUri: string): LspSymbol[] {
    if (!response)
        return [];
    return response.map((symbol) => {
        if ('location' in symbol) {
            return {
                name: symbol.name, kind: symbol.kind, uri: symbol.location.uri,
                range: symbol.location.range, containerName: symbol.containerName,
            };
        }
        return {
            name: symbol.name, kind: symbol.kind, uri: fallbackUri,
            range: symbol.range, selectionRange: symbol.selectionRange,
            detail: symbol.detail,
            ...(symbol.children ? { children: toLspSymbols(symbol.children, fallbackUri) } : {}),
        };
    });
}
