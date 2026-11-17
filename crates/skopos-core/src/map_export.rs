//! The resource map saved as a file (spec O §6.4, §6.5). The webview draws the canvas as a PNG;
//! this checks the image and writes it unchanged, or as a one-page PDF that holds it.

use std::io::{Cursor, Write as _};
use std::path::{Path, PathBuf};

use base64::Engine as _;
use flate2::write::ZlibEncoder;
use flate2::Compression;
use png::{BitDepth, ColorType, Decoder, Limits, Transformations};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::{ErrorCode, IpcError};

/// The most pixels an exported image may hold (spec O §6.4).
pub const MAX_PIXELS: u64 = 16_777_216;

/// A PDF point is 1/72 inch and a CSS pixel 1/96 inch.
const POINTS_PER_PIXEL: f64 = 0.75;

const NOT_VALID: &str = "The map image is not valid";

/// The file the map is saved as.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum MapFormat {
    Png,
    Pdf,
}

impl MapFormat {
    fn extension(self) -> &'static str {
        match self {
            MapFormat::Png => "png",
            MapFormat::Pdf => "pdf",
        }
    }
}

fn not_valid() -> IpcError {
    IpcError::new(ErrorCode::InvalidInput, NOT_VALID)
}

/// The PNG the webview sends, as base64 without a `data:` prefix.
pub fn decode_png_base64(png: &str) -> Result<Vec<u8>, IpcError> {
    base64::engine::general_purpose::STANDARD
        .decode(png)
        .map_err(|_| not_valid())
}

/// Writes the map drawn at `scale` image pixels per CSS pixel and returns the path written. A
/// path with no extension gains the format's; another extension is kept. The path must be
/// absolute. The file is written under a temporary name in the same folder and then renamed
/// over the path, so a failed write leaves nothing behind and a symlink at the path is replaced,
/// not followed.
pub fn write_map(
    path: &Path,
    format: MapFormat,
    png: &[u8],
    scale: f64,
) -> Result<PathBuf, IpcError> {
    if !(scale.is_finite() && scale > 0.0 && scale <= 2.0) {
        return Err(IpcError::new(
            ErrorCode::InvalidInput,
            "The map scale must be above 0 and at most 2",
        ));
    }
    if !path.is_absolute() {
        return Err(IpcError::new(
            ErrorCode::InvalidInput,
            "the destination path must be absolute",
        ));
    }
    let image = decode(png)?;
    let path = if path.extension().is_some() {
        path.to_owned()
    } else {
        path.with_extension(format.extension())
    };
    let folder = path.parent().ok_or_else(|| {
        IpcError::new(
            ErrorCode::InvalidInput,
            "the destination path has no folder",
        )
    })?;
    let pdf_bytes;
    let bytes = match format {
        MapFormat::Png => png,
        MapFormat::Pdf => {
            pdf_bytes = pdf(&image, scale)?;
            &pdf_bytes
        }
    };
    let mut file = temp_file_in(folder)?;
    file.write_all(bytes)?;
    file.persist(&path).map_err(|error| error.error)?;
    Ok(path)
}

/// A temporary file in `folder` that gets the mode a plain `std::fs::write` would give.
fn temp_file_in(folder: &Path) -> std::io::Result<tempfile::NamedTempFile> {
    let mut builder = tempfile::Builder::new();
    builder.prefix(".map-export-");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        builder.permissions(std::fs::Permissions::from_mode(0o666));
    }
    builder.tempfile_in(folder)
}

/// An image as 8-bit RGB samples, row by row from the top.
struct Rgb {
    width: u32,
    height: u32,
    samples: Vec<u8>,
}

/// A sample of alpha `alpha` drawn over white.
fn over_white(sample: u8, alpha: u8) -> u8 {
    let (sample, alpha) = (u16::from(sample), u16::from(alpha));
    let blended = (sample * alpha + 255 * (255 - alpha) + 127) / 255;
    u8::try_from(blended).unwrap_or(u8::MAX)
}

/// Decodes the PNG to RGB. `EXPAND` and `STRIP_16` leave 8-bit grey or RGB, with or without
/// alpha: grey becomes RGB, and alpha is drawn over white.
fn decode(png: &[u8]) -> Result<Rgb, IpcError> {
    // Room for the largest image at 16 bits per RGBA sample, before STRIP_16 halves it.
    let bytes = usize::try_from(MAX_PIXELS * 8).map_err(|_| not_valid())?;
    let mut decoder = Decoder::new_with_limits(Cursor::new(png), Limits { bytes });
    decoder.set_transformations(Transformations::EXPAND | Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|_| not_valid())?;
    let (width, height) = (reader.info().width, reader.info().height);
    let pixels = u64::from(width) * u64::from(height);
    if pixels == 0 || pixels > MAX_PIXELS {
        return Err(not_valid());
    }
    let size = reader.output_buffer_size().ok_or_else(not_valid)?;
    let mut buffer = vec![0; size];
    let frame = reader.next_frame(&mut buffer).map_err(|_| not_valid())?;
    let channels = match frame.color_type {
        ColorType::Grayscale => 1,
        ColorType::GrayscaleAlpha => 2,
        ColorType::Rgb => 3,
        ColorType::Rgba => 4,
        ColorType::Indexed => return Err(not_valid()),
    };
    if frame.bit_depth != BitDepth::Eight {
        return Err(not_valid());
    }
    buffer.truncate(frame.buffer_size());
    let mut samples = Vec::with_capacity(buffer.len() / channels * 3);
    for pixel in buffer.chunks_exact(channels) {
        let (rgb, alpha) = match *pixel {
            [grey] => ([grey; 3], u8::MAX),
            [grey, alpha] => ([grey; 3], alpha),
            [red, green, blue] => ([red, green, blue], u8::MAX),
            [red, green, blue, alpha] => ([red, green, blue], alpha),
            _ => return Err(not_valid()),
        };
        samples.extend(rgb.map(|sample| over_white(sample, alpha)));
    }
    Ok(Rgb {
        width,
        height,
        samples,
    })
}

/// A PDF number with at most 2 decimals and no trailing zeros: `75`, `37.5`.
fn number(value: f64) -> String {
    let text = format!("{value:.2}");
    text.trim_end_matches('0').trim_end_matches('.').to_owned()
}

/// A PDF stream object's body: a dictionary of `entries` and the data's `Length`, then the data.
fn stream(entries: &str, data: &[u8]) -> Vec<u8> {
    let entries = if entries.is_empty() {
        String::new()
    } else {
        format!("{entries} ")
    };
    let mut body = format!("<< {entries}/Length {} >>\nstream\n", data.len()).into_bytes();
    body.extend_from_slice(data);
    body.extend_from_slice(b"\nendstream");
    body
}

/// One page of the canvas's on-screen size, 1 CSS pixel to 0.75 pt, that holds the image
/// (spec O §6.5). Objects: 1 Catalog, 2 Pages, 3 Page, 4 content stream, 5 image.
fn pdf(image: &Rgb, scale: f64) -> Result<Vec<u8>, IpcError> {
    let width = number(f64::from(image.width) / scale * POINTS_PER_PIXEL);
    let height = number(f64::from(image.height) / scale * POINTS_PER_PIXEL);
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&image.samples)?;
    let pixels = encoder.finish()?;

    let objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
        format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width} {height}] \
             /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>"
        )
        .into_bytes(),
        stream(
            "",
            format!("q {width} 0 0 {height} 0 0 cm /Im0 Do Q").as_bytes(),
        ),
        stream(
            &format!(
                "/Type /XObject /Subtype /Image /Width {} /Height {} /ColorSpace /DeviceRGB \
                 /BitsPerComponent 8 /Filter /FlateDecode",
                image.width, image.height
            ),
            &pixels,
        ),
    ];

    // The second line's bytes above 127 mark the file as binary.
    let mut file = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n".to_vec();
    let mut offsets = Vec::with_capacity(objects.len());
    for (index, body) in objects.iter().enumerate() {
        offsets.push(file.len());
        file.extend_from_slice(format!("{} 0 obj\n", index + 1).as_bytes());
        file.extend_from_slice(body);
        file.extend_from_slice(b"\nendobj\n");
    }
    let xref = file.len();
    // Every entry is 20 bytes, its end of line included.
    let mut table = format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1);
    for offset in offsets {
        table.push_str(&format!("{offset:010} 00000 n \n"));
    }
    table.push_str(&format!(
        "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
        objects.len() + 1
    ));
    file.extend_from_slice(table.as_bytes());
    Ok(file)
}

#[cfg(test)]
mod tests {
    use std::io::Read as _;

    use flate2::read::ZlibDecoder;
    use png::{BitDepth, ColorType, Encoder};

    use super::*;

    fn encode(width: u32, height: u32, color: ColorType, depth: BitDepth, data: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::new();
        let mut encoder = Encoder::new(&mut bytes, width, height);
        encoder.set_color(color);
        encoder.set_depth(depth);
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(data).unwrap();
        writer.finish().unwrap();
        bytes
    }

    /// A `width` × `height` opaque RGB image whose every pixel is `rgb`.
    fn rgb_png(width: u32, height: u32, rgb: [u8; 3]) -> Vec<u8> {
        let pixels = usize::try_from(width * height).unwrap();
        let data = rgb.repeat(pixels);
        encode(width, height, ColorType::Rgb, BitDepth::Eight, &data)
    }

    /// The byte offset of the first `needle`.
    fn find(haystack: &[u8], needle: &[u8]) -> usize {
        haystack
            .windows(needle.len())
            .position(|window| window == needle)
            .unwrap_or_else(|| panic!("no {}", String::from_utf8_lossy(needle)))
    }

    /// The number written at the start of `bytes`.
    fn number_at(bytes: &[u8]) -> usize {
        let digits = bytes.iter().take_while(|b| b.is_ascii_digit()).count();
        std::str::from_utf8(&bytes[..digits])
            .unwrap()
            .parse()
            .unwrap()
    }

    /// For `contains` checks only: binary bytes change length, so offsets do not hold.
    fn text(pdf: &[u8]) -> String {
        String::from_utf8_lossy(pdf).into_owned()
    }

    /// The inflated data of object 5, the image.
    fn image_samples(pdf: &[u8]) -> Vec<u8> {
        let head = &pdf[find(pdf, b"5 0 obj\n")..];
        let length = number_at(&head[find(head, b"/Length ") + 8..]);
        let start = find(head, b"stream\n") + 7;
        let mut samples = Vec::new();
        ZlibDecoder::new(&head[start..start + length])
            .read_to_end(&mut samples)
            .unwrap();
        samples
    }

    fn pdf_of(png: &[u8], scale: f64) -> Vec<u8> {
        let dir = tempfile::tempdir().unwrap();
        let path = write_map(&dir.path().join("map"), MapFormat::Pdf, png, scale).unwrap();
        assert_eq!(path, dir.path().join("map.pdf"));
        std::fs::read(path).unwrap()
    }

    #[test]
    fn formats_serialize_as_the_interface_sends_them() {
        assert_eq!(
            serde_json::to_value([MapFormat::Png, MapFormat::Pdf]).unwrap(),
            serde_json::json!(["png", "pdf"])
        );
        let format: MapFormat = serde_json::from_str("\"pdf\"").unwrap();
        assert_eq!(format, MapFormat::Pdf);
    }

    #[test]
    fn a_png_is_written_unchanged_and_gains_its_extension() {
        let dir = tempfile::tempdir().unwrap();
        let png = rgb_png(3, 2, [10, 20, 30]);
        let path = write_map(&dir.path().join("map"), MapFormat::Png, &png, 2.0).unwrap();
        assert_eq!(path, dir.path().join("map.png"));
        assert_eq!(std::fs::read(&path).unwrap(), png);
    }

    #[test]
    fn another_extension_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let png = rgb_png(1, 1, [0, 0, 0]);
        let path = write_map(&dir.path().join("map.jpg"), MapFormat::Png, &png, 1.0).unwrap();
        assert_eq!(path, dir.path().join("map.jpg"));
        let path = write_map(&dir.path().join("map.jpg"), MapFormat::Pdf, &png, 1.0).unwrap();
        assert_eq!(path, dir.path().join("map.jpg"));
        assert!(std::fs::read(path).unwrap().starts_with(b"%PDF-1.4"));
    }

    #[test]
    fn a_pdf_is_one_page_of_the_on_screen_size() {
        let pdf = pdf_of(&rgb_png(200, 100, [10, 20, 30]), 2.0);
        assert!(pdf.starts_with(b"%PDF-1.4\n"));
        assert!(pdf.ends_with(b"%%EOF\n"));
        let text = text(&pdf);
        assert!(text.contains("/MediaBox [0 0 75 37.5]"), "{text}");
        assert!(
            text.contains("<< /Length 30 >>\nstream\nq 75 0 0 37.5 0 0 cm /Im0 Do Q\nendstream")
        );
        assert!(text.contains(
            "/Width 200 /Height 100 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode"
        ));
        assert!(text.contains("trailer\n<< /Size 6 /Root 1 0 R >>\n"));
        assert_eq!(image_samples(&pdf), [10, 20, 30].repeat(200 * 100));
    }

    #[test]
    fn the_cross_reference_table_points_at_each_object() {
        let pdf = pdf_of(&rgb_png(4, 3, [1, 2, 3]), 1.0);
        let startxref = pdf.windows(10).rposition(|w| w == b"startxref\n").unwrap();
        let xref = number_at(&pdf[startxref + 10..]);
        // Everything from the table on is text.
        let table = std::str::from_utf8(&pdf[xref..]).unwrap();
        assert!(
            table.starts_with("xref\n0 6\n0000000000 65535 f \n"),
            "{table}"
        );
        for (number, entry) in table.lines().skip(2).take(6).enumerate().skip(1) {
            assert_eq!(entry.len(), 19, "{entry:?} is 20 bytes with its newline");
            assert!(entry.ends_with(" 00000 n "), "{entry:?}");
            let offset = number_at(entry.as_bytes());
            assert!(
                pdf[offset..].starts_with(format!("{number} 0 obj\n").as_bytes()),
                "object {number} at {offset}"
            );
        }
    }

    #[test]
    fn page_sizes_keep_at_most_two_decimals() {
        assert_eq!(number(75.0), "75");
        assert_eq!(number(37.5), "37.5");
        assert_eq!(number(100.0), "100");
        assert_eq!(number(0.333_333), "0.33");
        assert_eq!(number(12.005_1), "12.01");
        let pdf = pdf_of(&rgb_png(1, 2, [0, 0, 0]), 0.9);
        assert!(text(&pdf).contains("/MediaBox [0 0 0.83 1.67]"));
    }

    #[test]
    fn alpha_is_drawn_over_white_and_grey_becomes_rgb() {
        let rgba = encode(
            3,
            1,
            ColorType::Rgba,
            BitDepth::Eight,
            &[10, 20, 30, 0, 10, 20, 30, 255, 0, 0, 0, 128],
        );
        assert_eq!(
            image_samples(&pdf_of(&rgba, 1.0)),
            [255, 255, 255, 10, 20, 30, 127, 127, 127]
        );
        let grey = encode(2, 1, ColorType::Grayscale, BitDepth::Eight, &[0, 200]);
        assert_eq!(image_samples(&pdf_of(&grey, 1.0)), [0, 0, 0, 200, 200, 200]);
        let grey_alpha = encode(1, 1, ColorType::GrayscaleAlpha, BitDepth::Eight, &[0, 0]);
        assert_eq!(image_samples(&pdf_of(&grey_alpha, 1.0)), [255, 255, 255]);
        let deep = encode(
            1,
            1,
            ColorType::Rgb,
            BitDepth::Sixteen,
            &[0x12, 0x34, 0, 0, 0xff, 0xff],
        );
        assert_eq!(image_samples(&pdf_of(&deep, 1.0)), [0x12, 0, 0xff]);
        let bits = encode(8, 1, ColorType::Grayscale, BitDepth::One, &[0b1010_0000]);
        assert_eq!(
            image_samples(&pdf_of(&bits, 1.0)),
            [[255; 3], [0; 3], [255; 3], [0; 3], [0; 3], [0; 3], [0; 3], [0; 3]].concat()
        );
    }

    #[test]
    fn what_is_not_a_map_image_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("map.png");
        let too_big = encode(
            4097,
            4096,
            ColorType::Grayscale,
            BitDepth::One,
            &vec![0; 513 * 4096],
        );
        for png in [
            b"not a png".to_vec(),
            Vec::new(),
            rgb_png(2, 2, [0; 3])[..40].to_vec(),
            too_big,
        ] {
            for format in [MapFormat::Png, MapFormat::Pdf] {
                let error = write_map(&path, format, &png, 1.0).unwrap_err();
                assert_eq!(
                    (error.code, error.message.as_str()),
                    (ErrorCode::InvalidInput, NOT_VALID)
                );
            }
        }
        let png = rgb_png(1, 1, [0; 3]);
        for scale in [0.0, -1.0, 3.0, f64::NAN, f64::INFINITY] {
            let error = write_map(&path, MapFormat::Png, &png, scale).unwrap_err();
            assert_eq!(error.code, ErrorCode::InvalidInput, "{scale}");
        }
        assert!(!path.exists(), "nothing is written");
    }

    #[test]
    fn base64_that_does_not_decode_is_refused() {
        let png = rgb_png(1, 1, [0; 3]);
        let encoded = base64::engine::general_purpose::STANDARD.encode(&png);
        assert_eq!(decode_png_base64(&encoded).unwrap(), png);
        for bad in ["not base64!", "data:image/png;base64,AAAA"] {
            let error = decode_png_base64(bad).unwrap_err();
            assert_eq!(
                (error.code, error.message.as_str()),
                (ErrorCode::InvalidInput, NOT_VALID)
            );
        }
    }

    #[test]
    fn a_missing_directory_gives_the_io_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missing").join("map.png");
        let error = write_map(&path, MapFormat::Png, &rgb_png(1, 1, [0; 3]), 1.0).unwrap_err();
        assert_eq!(error.code, ErrorCode::NotFound);
    }

    #[test]
    fn a_relative_path_is_refused() {
        let error = write_map(
            Path::new("map.png"),
            MapFormat::Png,
            &rgb_png(1, 1, [0; 3]),
            1.0,
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput);
        assert_eq!(error.message, "the destination path must be absolute");
    }

    #[test]
    fn an_existing_file_is_replaced_whole() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("map.png");
        std::fs::write(&path, vec![7u8; 4096]).unwrap();
        let png = rgb_png(1, 1, [0; 3]);
        write_map(&path, MapFormat::Png, &png, 1.0).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), png);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_at_the_path_is_replaced_not_followed() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target.txt");
        std::fs::write(&target, "keep").unwrap();
        let path = dir.path().join("map.png");
        std::os::unix::fs::symlink(&target, &path).unwrap();
        let png = rgb_png(1, 1, [0; 3]);
        write_map(&path, MapFormat::Png, &png, 1.0).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "keep");
        assert!(std::fs::symlink_metadata(&path)
            .unwrap()
            .file_type()
            .is_file());
        assert_eq!(std::fs::read(&path).unwrap(), png);
    }

    #[test]
    fn a_failed_write_leaves_no_file_behind() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("map.png");
        std::fs::create_dir(&path).unwrap();
        write_map(&path, MapFormat::Png, &rgb_png(1, 1, [0; 3]), 1.0).unwrap_err();
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, ["map.png"]);
    }

    #[cfg(unix)]
    #[test]
    fn the_file_gets_the_same_mode_as_a_plain_write() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = tempfile::tempdir().unwrap();
        let plain = dir.path().join("plain.png");
        std::fs::write(&plain, b"x").unwrap();
        let path = write_map(
            &dir.path().join("map"),
            MapFormat::Png,
            &rgb_png(1, 1, [0; 3]),
            1.0,
        )
        .unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&path), mode(&plain));
    }
}
