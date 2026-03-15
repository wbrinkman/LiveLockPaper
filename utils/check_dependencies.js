import Gst from 'gi://Gst';

// Check whether gtk4paintablesink is available (after Gst init).
export function isGtk4PaintableSinkAvailable() {
    try {
        return Gst.ElementFactory.find('gtk4paintablesink') !== null;
    } catch (e) {
        return false;
    }
}
