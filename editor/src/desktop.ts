import { mountEditor } from "./core";
import { EditorHostApi } from "./editor-host-api";
import { NativeHostTransport } from "./native-host";
mountEditor(new EditorHostApi(new NativeHostTransport()));
