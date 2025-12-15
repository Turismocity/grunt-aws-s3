/*
 * grunt-aws-s3
 * https://github.com/MathieuLoutre/grunt-aws-s3
 *
 * Copyright (c) 2015 Mathieu Triay
 * Licensed under the MIT license.
 */

'use strict';

var path = require('path');
var fs = require('fs');
var crypto = require('crypto');
var mime = require('mime-types');
var _ = require('lodash');
var async = require('async');
var Progress = require('progress');

// AWS SDK v3 imports
var { S3Client, ListObjectsV2Command, PutObjectCommand } = require('@aws-sdk/client-s3');

module.exports = function (grunt) {

	grunt.registerMultiTask('aws_s3', 'Interact with AWS S3 using the AWS SDK', function () {

		var done = this.async();

		var options = this.options({
			access: 'public-read',
			accessKeyId: process.env.AWS_ACCESS_KEY_ID,
			secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
			sessionToken: process.env.AWS_SESSION_TOKEN,
			uploadConcurrency: 1,
			mime: {},
			params: {},
			debug: false,
			differential: false,
			displayChangesOnly: false,
			progress: 'dots',
			overwrite: true,
			changedFiles: 'aws_s3_changed',
			compressionTypes: {'.br': 'br', '.gz': 'gzip'}
		});

		if (['dots','progressBar','none'].indexOf(options.progress) < 0) {
			grunt.log.writeln('Invalid progress option; defaulting to dots\n'.yellow);
			options.progress = 'dots';
		}

		var filePairOptions = {
			differential: options.differential
		};

		// List of acceptable params for an upload
		var put_params = ['CacheControl', 'ContentDisposition', 'ContentEncoding',
			'ContentLanguage', 'ContentLength', 'ContentMD5', 'Expires', 'GrantFullControl',
			'GrantRead', 'GrantReadACP', 'GrantWriteACP', 'Metadata', 'ServerSideEncryption',
			'StorageClass', 'WebsiteRedirectLocation', 'ContentType'];

		// Checks that all params are in put_params
		var isValidParams = function (params) {

			return _.every(_.keys(params), function (key) {
				return put_params.includes(key);
			});
		};

		var getObjectURL = function (file) {

			file = file || '';
			// In v3, we construct the URL manually
			var region = options.region || 'us-east-1';
			var endpoint = options.endpoint || `https://s3.${region}.amazonaws.com`;
			var prefix = endpoint.replace(/\/$/, '') + '/';

			return prefix + options.bucket + '/' + file;
		};


		var hashFile = function (options, callback) {
			var local_buffer = grunt.file.read(options.file_path, { encoding: null });
			callback(null, '"' + crypto.createHash('md5').update(local_buffer).digest('hex') + '"');
		};

		// Checks that local file is 'date_compare' than server file
		var checkFileDate = function (options, callback) {

			fs.stat(options.file_path, function (err, stats) {

				if (err) {
					callback(err);
				}
				else {
					var local_date = new Date(stats.mtime).getTime();
					var server_date = new Date(options.server_date).getTime();

					if (options.compare_date === 'newer') {
						callback(null, local_date > server_date);
					}
					else {
						callback(null, local_date < server_date);
					}
				}
			});
		};

		var isFileDifferent = function (options, callback) {

			hashFile(options, function (err, md5_hash) {

				if (err) {
					callback(err);
				}
				else {
					if (md5_hash === options.server_hash) {
						callback(null, false);
					}
					else {
						if (options.server_date) {
							options.compare_date = options.compare_date || 'older';
							checkFileDate(options, callback);
						}
						else {
							callback(null, true);
						}
					}
				}
			});
		};

		if (!options.bucket) {
			grunt.warn("Missing bucket in options");
		}

		// Build credentials object
		var credentials = undefined;
		if (options.accessKeyId && options.secretAccessKey) {
			credentials = {
				accessKeyId: options.accessKeyId,
				secretAccessKey: options.secretAccessKey,
				sessionToken: options.sessionToken
			};
		}
		// If no credentials provided, AWS SDK v3 will use default credential chain
		// (environment variables, IAM roles, etc.)

		var s3_config = {
			region: options.region || 'us-east-1', // Default region
			credentials: credentials
		};

		if (!options.region) {
			grunt.log.writeln("No region defined. S3 will default to us-east-1\n".yellow);
		}

		if (options.endpoint) {
			s3_config.endpoint = options.endpoint;
		}

		if (options.params) {
			if (!isValidParams(options.params)) {
				grunt.warn('"params" can only be ' + put_params.join(', '));
			}
		}

		// Allow additional (not required) options
		if (options.maxRetries !== undefined) {
			s3_config.maxAttempts = options.maxRetries + 1; // v3 uses maxAttempts
		}
		if (options.httpOptions) {
			s3_config.requestHandler = options.httpOptions;
		}
		if (options.s3ForcePathStyle !== undefined) {
			s3_config.forcePathStyle = options.s3ForcePathStyle;
		}

		var s3 = new S3Client(s3_config);

		var dest;
		var is_expanded;
		var uploads = [];

		var missingExpand = _.find(this.files, function(filePair) {
			return ! filePair.orig.expand && filePair.cwd;
		});

		if (missingExpand) {
			grunt.warn("File upload action has 'cwd' but is missing 'expand: true', src list will not expand!");
		}

		this.files.forEach(function (filePair) {

			is_expanded = filePair.orig.expand || false;

			if (!filePair.dest) {
				grunt.fatal("Specify a dest for uploads (e.g. '/' for the root)");
			}
			else if (filePair.params && !isValidParams(filePair.params)) {
				grunt.warn('"params" can only be ' + put_params.join(', '));
			}
			else {
				filePair.params = _.defaults(filePair.params || {}, options.params);
				_.defaults(filePair, filePairOptions);

				filePair.src.forEach(function (src) {

					// Prevents creating empty folders
					if (!grunt.file.isDir(src)) {

						if (_.last(filePair.dest) === '/') {
							dest = (is_expanded) ? filePair.dest : unixifyPath(path.join(filePair.dest, src));
						}
						else {
							dest = filePair.dest;
						}

						if (_.first(dest) === '/') {
							dest = dest.slice(1);
						}

						// '.' means that no dest path has been given (root). Nothing to create there.
						if (dest !== '.') {

							uploads.push(_.defaults({
								need_upload: true,
								src: src,
								dest: dest
							}, filePair));
						}
					}
				});
			}
		});

		// Will list *all* the content of the bucket given in options
		// Recursively requests the bucket with a continuation token if there's more than
		// 1000 objects. Ensures uniqueness of keys in the returned list.
		var listObjects = function (prefix, callback, continuationToken, contents) {

			var search = {
				Prefix: prefix,
				Bucket: options.bucket
			};

			if (continuationToken) {
				search.ContinuationToken = continuationToken;
			}

			var command = new ListObjectsV2Command(search);
			
			s3.send(command).then(function (list) {

				var objects = (contents) ? contents.concat(list.Contents || []) : (list.Contents || []);

				if (list.IsTruncated && list.NextContinuationToken) {
					listObjects(prefix, callback, list.NextContinuationToken, objects);
				}
				else {
					callback(_.uniq(objects, function (o) { return o.Key; }));
				}
			}).catch(function (err) {
				grunt.fatal('Failed to list content of bucket ' + options.bucket + '\n' + err);
			});
		};



		var doUpload = function (object, callback) {

			if (object.need_upload && !options.debug) {

				var type = options.mime[object.src] || object.params.ContentType || mime.contentType(mime.lookup(object.src) || "application/octet-stream");
				var upload = _.defaults({
					ContentType: type,
					Key: object.dest,
					Bucket: options.bucket,
					ACL: options.access
				}, object.params);

				upload.Body = grunt.file.read(object.src, { encoding: null });

				var command = new PutObjectCommand(upload);
				s3.send(command).then(function (data) {
					callback(null, true);
				}).catch(function (err) {
					callback(err, true);
				});
			}
			else {
				callback(null, false);
			}
		};

		var uploadObjects = function (task, callback) {

			grunt.log.writeln('Uploading to ' + getObjectURL('').cyan);

			var startUploads = function (server_files) {

				var upload_queue = async.queue(function (object, uploadCallback) {

					var server_file = _.filter(server_files, { Key: object.dest })[0];

					if (server_file && !options.overwrite) {
						uploadCallback(object.dest + " already exists!")
					}
					else if (server_file && object.differential) {

						isFileDifferent({ file_path: object.src, server_hash: server_file.ETag }, function (err, different) {
							object.need_upload = different;
							setImmediate(doUpload, object, uploadCallback);
						});
					}
					else {
						setImmediate(doUpload, object, uploadCallback);
					}

				}, options.uploadConcurrency);

				upload_queue.drain(function () {
					callback(null, task.files);
				});

				if (options.progress === 'progressBar') {
					var progress = new Progress('[:bar] :current/:total :etas', { total : task.files.length });
				}

				upload_queue.push(task.files, function (err, uploaded) {

					if (err) {
						grunt.fatal('Failed to upload ' + this.data.src + ' with bucket ' + options.bucket + '\n' + err);
					}
					else {
						switch(options.progress){
							case 'progressBar':
								progress.tick();
								break;
							case 'none':
								break;
							case 'dots':
							default:
								var dot = (uploaded) ? '.'.green : '.'.yellow;
								grunt.log.write(dot);
								break;
						}
					}
				});
			};

			var unique_dests = _(task.files)
				.filter('differential')
				.map('dest')
				.compact()
				.map(path.dirname)
				.sort()
				.uniq(true)
				.reduce(function (res, dest) {

					var last_path = res[res.length - 1];

					if (!last_path || dest.indexOf(last_path) !== 0) {
						res.push(dest);
					}

					return res;
				}, []);

			// If there's a '.', we need to scan the whole bucket
			if (unique_dests.indexOf('.') > -1 || !options.overwrite) {
				unique_dests = [''];
			}

			if (unique_dests.length) {
				async.mapLimit(unique_dests, options.uploadConcurrency, function (dest, callback) {
					listObjects(dest, function (objects) {
						callback(null, objects);
					});
				}, function (err, objects) {
					if (err) {
						callback(err);
					}
					else {
						var server_files = Array.prototype.concat.apply([], objects);
						startUploads(server_files);
					}
				});
			} else {
				startUploads([]);
			}
		};

		// Process uploads
		if (uploads.length === 0) {
			grunt.log.writeln('No files to upload');
			done();
		}
		else {
			var task = { files: uploads };
			uploadObjects(task, function (err, res) {
				if (err) {
					grunt.fatal('Upload failed\n' + err.toString());
				}
				else {
					var object_url = getObjectURL('');
					grunt.log.writeln('\nList: (' + res.length.toString().cyan + ' objects):');

					var uploaded = 0;

					_.each(res, function (file) {
						if (file.need_upload) {
							uploaded++;
							grunt.log.writeln('- ' + file.src.cyan + ' -> ' + (object_url + file.dest).cyan);
						}
						else if (!options.displayChangesOnly) {
							grunt.log.writeln('- ' + file.src.yellow + ' === ' + (object_url + file.dest).yellow);
						}
					});

					grunt.log.writeln(uploaded.toString().green + '/' + res.length.toString().green + ' objects uploaded to bucket ' + (options.bucket + '/').green);

					if (options.debug) {
						grunt.log.writeln("\nThe debug option was enabled, no changes have actually been made".yellow);
					}

					done();
				}
			});
		}
	});

	var unixifyPath = function (filepath) {

		if (process.platform === 'win32') {
			return filepath.replace(/\\/g, '/');
		}
		else {
			return filepath;
		}
	};
};
