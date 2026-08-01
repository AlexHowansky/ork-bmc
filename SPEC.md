## Battle Mapper

You are a web development expert. You are designing a new web application. This
document explains the requirements that must be adhered to.

## Architecture & Design

* Use bun as a runtime, so the app must be authored in JavaScript or something
  that transpiles to JavaScript.

* Use SQLite3 for local storage. The app will support a low number of users,
  and the load will never be heavy.

* Use Tailwind for styling. Always offer light and dark mode for visual
  elements.

* Observe OWASP Top Ten guidelines.

* Observe best practices for modern web development.

* All error messages should be user-friendly.

* Implement consistent logging to aid debugging.

## Features

The app will act as a manager for battle maps used in table-top role-playing
games. These maps are image files with some associated metadata. Implement
the following features:

* Access to all pages is gated by email/password authentication.

* Users are either viewers (read-only) or administrators (read-write).

* Users will not be able to register themselves. User accounts will be added by
  a local administrator with a CLI tool that you will create. The CLI tool
  should expect all arguments to be provided on the command line, it does not
  need to be interactive.

* The CLI tool should support the following commands: `create`, `delete`, `list`,
  `change-role`, and `change-password`.

* Once logged in, users can see thumbnails of the current maps in a paginated
  view.

* A user can click on a thumbnail to view a map detail page. This page should
  display the full resolution version of the map, all metadata, and a download
  button.

* Administrators can upload, edit, and delete maps. Allow PNG, JPG, and WEBP
  images to be uploaded. Convert all images to WEBP after upload. Assign new
  images a unique name based on a UUID v4. Always use this UUID to refer to
  the image, do not use an autoincrement primary key in the database.

* Map images will often have a visible square grid on them. If present, we need
  to know the number of pixels per grid square (the grid size), the number of
  squares horizontally, and the number of squares vertically.

* The map upload page should include fields for metadata. These fields must
  include `name`, `variant`, `tags`, `grid size`, `grid width`, and
  `grid height`. The image metadata should be stored as separate database
  columns, to benefit querying.

* The `tags` field can contain an arbitrary number of text tags like `forest`,
  `road`, `desert`, and `camp`. Tags can contain only lowercase letters.

* Users can search for images based on name or tags. The name and tags columns
  should be indexed to benefit searching. When searching tags, support multiple
  tags with AND/OR logic. All searches should be performed case-insensitively.

* If the user does not provide a value for `grid size`, `grid width`, or
  `grid height`, attempt to determine them automatically by looking for a
  visible grid pattern in the image. In this case, if the detected `grid size`
  is not an integer, upscale the image just enough to make it an integer.

* Additionally detect and store metadata for `image width` and `image height`.
  This is the numer of pixels and is unrelated to the grid.

* Images should be stored in a dedicated configurable directory. The full
  resolution version of the maps must never be reachable without authentication.
  This directory should be further divided into subdirectories so that no single
  directory contains too many files. Use the first two characters of the UUID v4
  file name to name the subdirectories.

* The maximum supported image file size should be configurable.

* When the user submits the new map upload form or the map edit form, if the
  grid width or grid height values have changed, then calculate if the grid
  size is an integer. if not an integer, upscale the image the minimum amount
  required to make the grid size an integer. For example, given an image that
  is 1000x1000 pixels, if the user specifies a grid width of 30 and a grid
  height of 30, then the image should be resized to 1020x1020 the grid size
  should be set to 34. If the calculation determines that the grid size is not
  square, abort with an error.

* When a map is uploaded, generate a fingerprint for it. Use this fingerprint to
  determine if this new image is substantially similar to any previously
  uploaded map. If so, alert the user, showing all the matching images. Pre-fill
  the map name field with the name from the matching map. Recommend to the user
  that they leave the matching name and provide a new variant. Nothing should be
  added to the library until the user confirms, and they must be able to discard
  the upload instead. How similar two images must be to match should be
  configurable.

* When uploading a new map, default the map name to the file name of the
  uploaded file.

* The upload form should accept drag-and-drop.

* The filename for the map download should include the variant. If every image
  is downloaded, each should have a unique name.

* On the map detail page, clicking on the map should show it full size.

* The image storage format (default WEBP), image quality (default 95), and
  lossless flag (default false) should be controlled by .env file settings.

## Additional Rules

Always obey the following rules:

* Images that are resized or changed to a different format should never be
  reduced in quality.

* Implement CSRF protection on all forms.

## Conclusion

Ask me about design decisions or for any additional details you may need.
