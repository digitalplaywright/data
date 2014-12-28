var get = Ember.get;
var forEach = Ember.EnumerableUtils.forEach;
var camelize = Ember.String.camelize;

/**
  ## Using Embedded Records

  `DS.EmbeddedRecordsMixin` supports serializing embedded records.

  To set up embedded records, include the mixin when extending a serializer
  then define and configure embedded (model) relationships.

  Below is an example of a per-type serializer ('post' type).

  ```js
  App.PostSerializer = DS.RESTSerializer.extend(DS.EmbeddedRecordsMixin, {
    attrs: {
      author: { embedded: 'always' },
      comments: { serialize: 'ids' }
    }
  });
  ```
  Note that this use of `{ embedded: 'always' }` is unrelated to
  the `{ embedded: 'always' }` that is defined as an option on `DS.attr` as part of
  defining a model while working with the ActiveModelSerializer.  Nevertheless,
  using `{ embedded: 'always' }` as an option to DS.attr is not a valid way to setup
  embedded records.

  The `attrs` option for a resource `{ embedded: 'always' }` is shorthand for:

  ```js
  {
    serialize: 'records',
    deserialize: 'records'
  }
  ```

  ### Configuring Attrs

  A resource's `attrs` option may be set to use `ids`, `records` or false for the
  `serialize`  and `deserialize` settings.

  The `attrs` property can be set on the ApplicationSerializer or a per-type
  serializer.

  In the case where embedded JSON is expected while extracting a payload (reading)
  the setting is `deserialize: 'records'`, there is no need to use `ids` when
  extracting as that is the default behavior without this mixin if you are using
  the vanilla EmbeddedRecordsMixin. Likewise, to embed JSON in the payload while
  serializing `serialize: 'records'` is the setting to use. There is an option of
  not embedding JSON in the serialized payload by using `serialize: 'ids'`. If you
  do not want the relationship sent at all, you can use `serialize: false`.


  ### EmbeddedRecordsMixin defaults
  If you do not overwrite `attrs` for a specific relationship, the `EmbeddedRecordsMixin`
  will behave in the following way:

  BelongsTo: `{ serialize: 'id', deserialize: 'id' }`
  HasMany:   `{ serialize: false, deserialize: 'ids' }`

  ### Model Relationships

  Embedded records must have a model defined to be extracted and serialized. Note that
  when defining any relationships on your model such as `belongsTo` and `hasMany`, you
  should not both specify `async:true` and also indicate through the serializer's
  `attrs` attribute that the related model should be embedded.  If a model is
  declared embedded, then do not use `async:true`.

  To successfully extract and serialize embedded records the model relationships
  must be setup correcty See the
  [defining relationships](/guides/models/defining-models/#toc_defining-relationships)
  section of the **Defining Models** guide page.

  Records without an `id` property are not considered embedded records, model
  instances must have an `id` property to be used with Ember Data.

  ### Example JSON payloads, Models and Serializers

  **When customizing a serializer it is important to grok what the customizations
  are. Please read the docs for the methods this mixin provides, in case you need
  to modify it to fit your specific needs.**

  For example review the docs for each method of this mixin:
  * [normalize](/api/data/classes/DS.EmbeddedRecordsMixin.html#method_normalize)
  * [serializeBelongsTo](/api/data/classes/DS.EmbeddedRecordsMixin.html#method_serializeBelongsTo)
  * [serializeHasMany](/api/data/classes/DS.EmbeddedRecordsMixin.html#method_serializeHasMany)

  @class EmbeddedRecordsMixin
  @namespace DS
*/
var EmbeddedRecordsMixin = Ember.Mixin.create({

  /**
    Normalize the record and recursively normalize/extract all the embedded records
    while pushing them into the store as they are encountered

    A payload with an attr configured for embedded records needs to be extracted:

    ```js
    {
      "post": {
        "id": "1"
        "title": "Rails is omakase",
        "comments": [{
          "id": "1",
          "body": "Rails is unagi"
        }, {
          "id": "2",
          "body": "Omakase O_o"
        }]
      }
    }
    ```
   @method normalize
   @param {subclass of DS.Model} type
   @param {Object} hash to be normalized
   @param {String} key the hash has been referenced by
   @return {Object} the normalized hash
  **/
  normalize: function(type, hash, prop) {
    var normalizedHash = this._super(type, hash, prop);
    return extractEmbeddedRecords(this, this.store, type, normalizedHash);
  },

  keyForRelationship: function(key, type){
    if (this.hasDeserializeRecordsOption(key)) {
      return this.keyForAttribute(key);
    } else {
      return this._super(key, type) || key;
    }
  },

  keyForEmbeddedAttribute: function(attr){
    var key = this.keyForAttribute(attr);
    return this.formatEmbeddedKey ? this.formatEmbeddedKey(key) : key;
  },


  /**
   Add deleted records to the json if they are already persisted.
   @method addDeletedRecords
   @param {DS.Model} record
   @param {String}   key
   @return {Object}  jsonArray
  **/
  addDeletedRecords: function (record, key, jsonArray) {
    var deletedRecords = record.get(key + '.relationship.deleted');

    if (deletedRecords) {

        deletedRecords.forEach(function (deletedRecord) {

        if (deletedRecord.get('isDeleted') && !deletedRecord.get('isNew')) {
          var serialized = deletedRecord.serialize({ includeId: true });

          serialized._destroy = true;

          jsonArray.pushObject(serialized);
        }
      });
    }
  },

  /**
     Mark all deleted records as didCommit.
     @method didCommitDeletedRecords
     @param {DS.Model} record
  **/
  didUpdateDeletedRecords: function (record) {
    function didCommitDeletedRecord(record) {
      record.transitionTo('deleted.saved');
      record.unloadRecord();
    }

    function didCommitDeletedRecords(name) {
      var deletedKey = name + '.relationship.deleted';
      var deletedRecords = record.get(deletedKey);
      if (deletedRecords) {
        deletedRecords.forEach(didCommitDeletedRecord);
        deletedRecords.clear();
      }
    }
    record.eachRelationship(didCommitDeletedRecords);
  },

   /**
     Failed to commit. Server and client side is not in
     sync.

     @method didFailToCommitDeletedRecords
     @param {DS.Model} record
   **/

  didFailToCommitDeletedRecords: function (record) {

      //FIXME: can we use contextual info from the server
      //to give better error message?
      record.set('isError', true);
      throw "failed to commit deleted record";
  },

  /**
    Serialize `belongsTo` relationship when it is configured as an embedded object.

    This example of an author model belongs to a post model:

    ```js
    Post = DS.Model.extend({
      title:    DS.attr('string'),
      body:     DS.attr('string'),
      author:   DS.belongsTo('author')
    });

    Author = DS.Model.extend({
      name:     DS.attr('string'),
      post:     DS.belongsTo('post')
    });
    ```

    Use a custom (type) serializer for the post model to configure embedded author

    ```js
    App.PostSerializer = DS.RESTSerializer.extend(DS.EmbeddedRecordsMixin, {
      attrs: {
        author: {embedded: 'always'}
      }
    })
    ```

    A payload with an attribute configured for embedded records can serialize
    the records together under the root attribute's payload:

    ```js
    {
      "post": {
        "id": "1"
        "title": "Rails is omakase",
        "author": {
          "id": "2"
          "name": "dhh"
        }
      }
    }
    ```

    @method serializeBelongsTo
    @param {DS.Model} record
    @param {Object} json
    @param {Object} relationship
  */
  serializeBelongsTo: function(record, json, relationship) {
    var attr = relationship.key;
    if (this.noSerializeOptionSpecified(attr)) {
      this._super(record, json, relationship);
      return;
    }
    var includeIds = this.hasSerializeIdsOption(attr);
    var includeRecords = this.hasSerializeRecordsOption(attr);
    var embeddedRecord = record.get(attr);
    var key;
    if (includeIds) {
      key = this.keyForRelationship(attr, relationship.kind);
      if (!embeddedRecord) {
        json[key] = null;
      } else {
        json[key] = get(embeddedRecord, 'id');
      }
    } else if (includeRecords) {
      key = this.keyForEmbeddedAttribute(attr);
      if (!embeddedRecord) {
        json[key] = null;
      } else {
        json[key] = embeddedRecord.serialize({includeId: true});
        this.removeEmbeddedForeignKey(record, embeddedRecord, relationship, json[key]);
      }
    }
  },

  /**
    Serialize `hasMany` relationship when it is configured as embedded objects.

    This example of a post model has many comments:

    ```js
    Post = DS.Model.extend({
      title:    DS.attr('string'),
      body:     DS.attr('string'),
      comments: DS.hasMany('comment')
    });

    Comment = DS.Model.extend({
      body:     DS.attr('string'),
      post:     DS.belongsTo('post')
    });
    ```

    Use a custom (type) serializer for the post model to configure embedded comments

    ```js
    App.PostSerializer = DS.RESTSerializer.extend(DS.EmbeddedRecordsMixin, {
      attrs: {
        comments: {embedded: 'always'}
      }
    })
    ```

    A payload with an attribute configured for embedded records can serialize
    the records together under the root attribute's payload:

    ```js
    {
      "post": {
        "id": "1"
        "title": "Rails is omakase",
        "body": "I want this for my ORM, I want that for my template language..."
        "comments": [{
          "id": "1",
          "body": "Rails is unagi"
        }, {
          "id": "2",
          "body": "Omakase O_o"
        }]
      }
    }
    ```

    The attrs options object can use more specific instruction for extracting and
    serializing. When serializing, an option to embed `ids` or `records` can be set.
    When extracting the only option is `records`.

    So `{embedded: 'always'}` is shorthand for:
    `{serialize: 'records', deserialize: 'records'}`

    To embed the `ids` for a related object (using a hasMany relationship):

    ```js
    App.PostSerializer = DS.RESTSerializer.extend(DS.EmbeddedRecordsMixin, {
      attrs: {
        comments: {serialize: 'ids', deserialize: 'records'}
      }
    })
    ```

    ```js
    {
      "post": {
        "id": "1"
        "title": "Rails is omakase",
        "body": "I want this for my ORM, I want that for my template language..."
        "comments": ["1", "2"]
      }
    }
    ```

    @method serializeHasMany
    @param {DS.Model} record
    @param {Object} json
    @param {Object} relationship
  */
  serializeHasMany: function(record, json, relationship) {
    var attr = relationship.key;
    if (this.noSerializeOptionSpecified(attr)) {
      this._super(record, json, relationship);
      return;
    }
    var includeIds = this.hasSerializeIdsOption(attr);
    var includeRecords = this.hasSerializeRecordsOption(attr);
    var key;
    if (includeIds) {
      key = this.keyForRelationship(attr, relationship.kind);
      json[key] = get(record, attr).mapBy('id');
    } else if (includeRecords) {
      key = this.keyForEmbeddedAttribute(attr);
      json[key] = get(record, attr).map(function(embeddedRecord) {
        var serializedEmbeddedRecord = embeddedRecord.serialize({includeId: true});
        this.removeEmbeddedForeignKey(record, embeddedRecord, relationship, serializedEmbeddedRecord);
        return serializedEmbeddedRecord;
      }, this);

      //serialize deleted records

      this.addDeletedRecords(record, relationship.key, json[key]);

      record.one('didUpdate', this, 'didUpdateDeletedRecords');
      record.one('becameError', this, 'didFailToCommitDeletedRecords');

    }
  },

  /**
    When serializing an embedded record, modify the property (in the json payload)
    that refers to the parent record (foreign key for relationship).

    Serializing a `belongsTo` relationship removes the property that refers to the
    parent record

    Serializing a `hasMany` relationship does not remove the property that refers to
    the parent record.

    @method removeEmbeddedForeignKey
    @param {DS.Model} record
    @param {DS.Model} embeddedRecord
    @param {Object} relationship
    @param {Object} json
  */
  removeEmbeddedForeignKey: function (record, embeddedRecord, relationship, json) {
    if (relationship.kind === 'hasMany') {
      return;
    } else if (relationship.kind === 'belongsTo') {
      var parentRecord = record.constructor.inverseFor(relationship.key);
      if (parentRecord) {
        var name = parentRecord.name;
        var embeddedSerializer = this.store.serializerFor(embeddedRecord.constructor);
        var parentKey = embeddedSerializer.keyForRelationship(name, parentRecord.kind);
        if (parentKey) {
          delete json[parentKey];
        }
      }
    }
  },

  // checks config for attrs option to embedded (always) - serialize and deserialize
  hasEmbeddedAlwaysOption: function (attr) {
    var option = this.attrsOption(attr);
    return option && option.embedded === 'always';
  },

  // checks config for attrs option to serialize ids
  hasSerializeRecordsOption: function(attr) {
    var alwaysEmbed = this.hasEmbeddedAlwaysOption(attr);
    var option = this.attrsOption(attr);
    return alwaysEmbed || (option && (option.serialize === 'records'));
  },

  // checks config for attrs option to serialize records
  hasSerializeIdsOption: function(attr) {
    var option = this.attrsOption(attr);
    return option && (option.serialize === 'ids' || option.serialize === 'id');
  },

  // checks config for attrs option to serialize records
  noSerializeOptionSpecified: function(attr) {
    var option = this.attrsOption(attr);
    return !(option && (option.serialize || option.embedded));
  },

  // checks config for attrs option to deserialize records
  // a defined option object for a resource is treated the same as
  // `deserialize: 'records'`
  hasDeserializeRecordsOption: function(attr) {
    var alwaysEmbed = this.hasEmbeddedAlwaysOption(attr);
    var option = this.attrsOption(attr);
    return alwaysEmbed || (option && option.deserialize === 'records');
  },

  attrsOption: function(attr) {
    var attrs = this.get('attrs');
    return attrs && (attrs[camelize(attr)] || attrs[attr]);
  }
});

// chooses a relationship kind to branch which function is used to update payload
// does not change payload if attr is not embedded
function extractEmbeddedRecords(serializer, store, type, partial) {

  type.eachRelationship(function(key, relationship) {
    if (serializer.hasDeserializeRecordsOption(key)) {
      var embeddedType = store.modelFor(relationship.type.typeKey);
      if (relationship.kind === "hasMany") {
        if (relationship.options.polymorphic) {
          extractEmbeddedHasManyPolymorphic(store, key, partial);
        }
        else {
          extractEmbeddedHasMany(store, key, embeddedType, partial);
        }
      }
      if (relationship.kind === "belongsTo") {
        extractEmbeddedBelongsTo(store, key, embeddedType, partial);
      }
    }
  });

  return partial;
}

// handles embedding for `hasMany` relationship
function extractEmbeddedHasMany(store, key, embeddedType, hash) {
  if (!hash[key]) {
    return hash;
  }

  var ids = [];

  var embeddedSerializer = store.serializerFor(embeddedType.typeKey);
  forEach(hash[key], function(data) {
    var embeddedRecord = embeddedSerializer.normalize(embeddedType, data, null);
    store.push(embeddedType, embeddedRecord);
    ids.push(embeddedRecord.id);
  });

  hash[key] = ids;
  return hash;
}

function extractEmbeddedHasManyPolymorphic(store, key, hash) {
  if (!hash[key]) {
    return hash;
  }

  var ids = [];

  forEach(hash[key], function(data) {
    var typeKey = data.type;
    var embeddedSerializer = store.serializerFor(typeKey);
    var embeddedType = store.modelFor(typeKey);
    var primaryKey = get(embeddedSerializer, 'primaryKey');

    var embeddedRecord = embeddedSerializer.normalize(embeddedType, data, null);
    store.push(embeddedType, embeddedRecord);
    ids.push({ id: embeddedRecord[primaryKey], type: typeKey });
  });

  hash[key] = ids;
  return hash;
}

function extractEmbeddedBelongsTo(store, key, embeddedType, hash) {
  if (!hash[key]) {
    return hash;
  }

  var embeddedSerializer = store.serializerFor(embeddedType.typeKey);
  var embeddedRecord = embeddedSerializer.normalize(embeddedType, hash[key], null);
  store.push(embeddedType, embeddedRecord);

  hash[key] = embeddedRecord.id;
  //TODO Need to add a reference to the parent later so relationship works between both `belongsTo` records
  return hash;
}

export default EmbeddedRecordsMixin;
