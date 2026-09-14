CLASS zcl_orvanta_smartform DEFINITION
  PUBLIC INHERITING FROM cl_ssf_fb_smart_form
  FINAL CREATE PRIVATE.
  PUBLIC SECTION.
    TYPE-POOLS cssf.
    CLASS-METHODS execute
      IMPORTING iv_action TYPE string iv_formname TYPE string
        iv_language TYPE string iv_version TYPE string
        iv_xml TYPE string iv_expected TYPE string
        iv_package TYPE string iv_transport TYPE string
      EXPORTING ev_protocol TYPE string ev_status TYPE string
        ev_code TYPE string ev_message TYPE string
        ev_formname TYPE string ev_language TYPE string
        ev_version TYPE string ev_xml TYPE string
        ev_fingerprint TYPE string ev_package TYPE string
        ev_active TYPE string ev_inactive TYPE string
        ev_request TYPE string.
  PROTECTED SECTION.
    METHODS set_correction_request REDEFINITION.
  PRIVATE SECTION.
    DATA mv_transport_error TYPE string.
    CLASS-METHODS snapshot
      IMPORTING iv_name TYPE tdsfname
      RETURNING value(rv_hash) TYPE string
      RAISING cx_abap_message_digest cx_ssf_fb.
    METHODS download
      IMPORTING iv_language TYPE sylangu
      RETURNING value(rv_xml) TYPE string
      RAISING cx_ssf_fb cx_abap_message_digest.
    METHODS upload
      IMPORTING iv_xml TYPE string iv_name TYPE tdsfname
        iv_language TYPE sylangu
      RAISING cx_ssf_fb cx_abap_message_digest.
ENDCLASS.

CLASS zcl_orvanta_smartform IMPLEMENTATION.
  METHOD set_correction_request.
    DATA lv_package TYPE devclass.
    DATA lv_request TYPE trkorr.
    DATA lv_object TYPE sobj_name.
    DATA lv_mode TYPE c LENGTH 1.
    CLEAR mv_transport_error.
    SELECT SINGLE obj_name FROM tadir INTO lv_object
      WHERE pgmid = 'R3TR' AND object = 'SSFO'
        AND obj_name = me->header-formname.
    IF sy-subrc <> 0. lv_mode = 'I'. ENDIF.
* No dialogs, implicit transport selection, or transport creation.
    CALL FUNCTION 'RS_CORR_INSERT'
      EXPORTING object = me->header-formname object_class = 'SSFO'
        mode = lv_mode
        global_lock = 'X' devclass = me->header-devclass
        korrnum = me->korrnum
        master_language = me->header-masterlang
        suppress_dialog = 'X'
      IMPORTING devclass = lv_package korrnum = lv_request
      EXCEPTIONS OTHERS = 1.
    IF sy-subrc <> 0.
      MESSAGE ID sy-msgid TYPE 'S' NUMBER sy-msgno
        WITH sy-msgv1 sy-msgv2 sy-msgv3 sy-msgv4
        INTO mv_transport_error.
      RAISE error.
    ENDIF.
    IF lv_package <> me->header-devclass
       OR lv_request <> me->korrnum.
      CONCATENATE 'CTS_RESULT_MISMATCH package=' lv_package
        'task=' lv_request INTO mv_transport_error
        SEPARATED BY space.
      RAISE error.
    ENDIF.
  ENDMETHOD.

  METHOD snapshot.
* Hash persisted data, not XML IDs (the SAP XML counter is mutable).
* Both versions and all languages participate in optimistic locking.
    DATA lt_adm TYPE STANDARD TABLE OF stxfadm.
    DATA lt_admt TYPE STANDARD TABLE OF stxfadmt.
    DATA lt_cont TYPE STANDARD TABLE OF stxfcont.
    DATA lt_conts TYPE STANDARD TABLE OF stxfconts.
    DATA lt_obj TYPE STANDARD TABLE OF stxfobjt.
    DATA lt_txt TYPE STANDARD TABLE OF stxftxt.
    DATA lt_var TYPE STANDARD TABLE OF stxfvar.
    DATA lt_vart TYPE STANDARD TABLE OF stxfvart.
    DATA lt_tadir TYPE STANDARD TABLE OF tadir.
    DATA lv_buffer TYPE xstring.
    SELECT * FROM stxfadm INTO TABLE lt_adm
      WHERE formname = iv_name ORDER BY PRIMARY KEY.
    SELECT * FROM stxfadmt INTO TABLE lt_admt UP TO 10001 ROWS
      WHERE formname = iv_name ORDER BY PRIMARY KEY.
    SELECT * FROM stxfcont INTO TABLE lt_cont UP TO 10001 ROWS
      WHERE formname = iv_name ORDER BY PRIMARY KEY.
    SELECT * FROM stxfconts INTO TABLE lt_conts UP TO 10001 ROWS
      WHERE formname = iv_name ORDER BY PRIMARY KEY.
    SELECT * FROM stxfobjt INTO TABLE lt_obj UP TO 10001 ROWS
      WHERE formname = iv_name ORDER BY PRIMARY KEY.
    SELECT * FROM stxftxt INTO TABLE lt_txt UP TO 10001 ROWS
      WHERE formname = iv_name ORDER BY PRIMARY KEY.
    SELECT * FROM stxfvar INTO TABLE lt_var UP TO 10001 ROWS
      WHERE formname = iv_name ORDER BY PRIMARY KEY.
    SELECT * FROM stxfvart INTO TABLE lt_vart UP TO 10001 ROWS
      WHERE formname = iv_name ORDER BY PRIMARY KEY.
    SELECT * FROM tadir INTO TABLE lt_tadir
      WHERE pgmid = 'R3TR' AND object = 'SSFO'
        AND obj_name = iv_name ORDER BY PRIMARY KEY.
    IF lines( lt_admt ) > 10000 OR lines( lt_cont ) > 10000
       OR lines( lt_conts ) > 10000 OR lines( lt_obj ) > 10000
       OR lines( lt_txt ) > 10000 OR lines( lt_var ) > 10000
       OR lines( lt_vart ) > 10000.
      RAISE EXCEPTION TYPE cx_ssf_fb.
    ENDIF.
    EXPORT adm = lt_adm admt = lt_admt cont = lt_cont
      conts = lt_conts obj = lt_obj txt = lt_txt
      var = lt_var vart = lt_vart tadir = lt_tadir
      TO DATA BUFFER lv_buffer.
    IF xstrlen( lv_buffer ) > 8388608.
      RAISE EXCEPTION TYPE cx_ssf_fb.
    ENDIF.
    CALL METHOD cl_abap_message_digest=>calculate_hash_for_raw
      EXPORTING if_algorithm = 'SHA256' if_data = lv_buffer
      IMPORTING ef_hashstring = rv_hash.
    TRANSLATE rv_hash TO LOWER CASE.
  ENDMETHOD.

  METHOD download.
    DATA lo_ixml TYPE REF TO if_ixml.
    DATA lo_doc TYPE REF TO if_ixml_document.
    DATA lo_sf TYPE REF TO if_ixml_element.
    DATA lo_factory TYPE REF TO if_ixml_stream_factory.
    DATA lo_output TYPE REF TO if_ixml_ostream.
    DATA lo_renderer TYPE REF TO if_ixml_renderer.
    DATA lv_rc TYPE i.
    DATA lv_language TYPE c LENGTH 2.
    DATA lv_language_text TYPE string.
    DATA lv_utf8 TYPE xstring.
    lo_ixml = cl_ixml=>create( ).
    lo_doc = lo_ixml->create_document( ).
    me->xml_init( ).
    me->xml_download( EXPORTING parent = lo_doc
                     CHANGING document = lo_doc ).
    lo_sf = lo_doc->get_root_element( ).
    IF lo_sf IS INITIAL.
      RAISE EXCEPTION TYPE cx_ssf_fb.
    ENDIF.
    lv_rc = lo_sf->set_attribute(
      name = 'sf' namespace = 'xmlns'
      value = cl_ssf_fb_sf_basis=>xml_ns_uri_sf ).
    IF lv_rc <> 0. RAISE EXCEPTION TYPE cx_ssf_fb. ENDIF.
    lv_rc = lo_sf->set_attribute(
      name = 'xmlns'
      value = cl_ssf_fb_sf_basis=>xml_ns_uri_ifr ).
    IF lv_rc <> 0. RAISE EXCEPTION TYPE cx_ssf_fb. ENDIF.
    WRITE iv_language TO lv_language.
    lv_language_text = lv_language.
    lv_rc = lo_sf->set_attribute( name = 'language'
      namespace = 'sf' value = lv_language_text ).
    IF lv_rc <> 0. RAISE EXCEPTION TYPE cx_ssf_fb. ENDIF.
    lo_factory = lo_ixml->create_stream_factory( ).
    lo_output = lo_factory->create_ostream_cstring( rv_xml ).
    lo_renderer = lo_ixml->create_renderer(
      document = lo_doc ostream = lo_output ).
    lv_rc = lo_renderer->render( ).
    IF lv_rc <> 0 OR strlen( rv_xml ) > 1048576.
      RAISE EXCEPTION TYPE cx_ssf_fb.
    ENDIF.
    lv_utf8 = cl_abap_message_digest=>string_to_xstring( rv_xml ).
    IF xstrlen( lv_utf8 ) > 1048576.
      RAISE EXCEPTION TYPE cx_ssf_fb.
    ENDIF.
  ENDMETHOD.

  METHOD upload.
    DATA lo_ixml TYPE REF TO if_ixml.
    DATA lo_doc TYPE REF TO if_ixml_document.
    DATA lo_factory TYPE REF TO if_ixml_stream_factory.
    DATA lo_input TYPE REF TO if_ixml_istream.
    DATA lo_parser TYPE REF TO if_ixml_parser.
    DATA lo_root TYPE REF TO if_ixml_element.
    DATA lo_result TYPE REF TO cl_ssf_fb_smart_form.
    DATA ls_variant LIKE LINE OF me->varheader.
    DATA lv_rc TYPE i.
    DATA lv_xml_language TYPE string.
    DATA lv_language TYPE sylangu.
    DATA lv_utf8 TYPE xstring.
    IF iv_xml IS INITIAL OR strlen( iv_xml ) > 1048576.
      RAISE EXCEPTION TYPE cx_ssf_fb.
    ENDIF.
    lv_utf8 = cl_abap_message_digest=>string_to_xstring( iv_xml ).
    IF xstrlen( lv_utf8 ) > 1048576.
      RAISE EXCEPTION TYPE cx_ssf_fb.
    ENDIF.
    FIND REGEX '<!(DOCTYPE|ENTITY)' IN iv_xml IGNORING CASE.
    IF sy-subrc = 0.
      RAISE EXCEPTION TYPE cx_ssf_fb.
    ENDIF.
    lo_ixml = cl_ixml=>create( ).
    lo_doc = lo_ixml->create_document( ).
    lo_factory = lo_ixml->create_stream_factory( ).
    lo_input = lo_factory->create_istream_string( iv_xml ).
    lo_parser = lo_ixml->create_parser(
      stream_factory = lo_factory istream = lo_input
      document = lo_doc ).
    lv_rc = lo_parser->parse( ).
    IF lv_rc <> 0.
      RAISE EXCEPTION TYPE cx_ssf_fb.
    ENDIF.
    lo_root = lo_doc->get_root_element( ).
    IF lo_root IS INITIAL.
      RAISE EXCEPTION TYPE cx_ssf_fb.
    ENDIF.
    IF lo_root->get_name( ) <> 'SMARTFORM'
       OR lo_root->get_namespace_uri( ) <>
          cl_ssf_fb_sf_basis=>xml_ns_uri_sf.
      RAISE EXCEPTION TYPE cx_ssf_fb.
    ENDIF.
    lv_xml_language = lo_root->get_attribute(
      name = 'language' namespace = 'sf' ).
    IF lv_xml_language IS NOT INITIAL.
      CALL FUNCTION 'CONVERSION_EXIT_ISOLA_INPUT'
        EXPORTING input = lv_xml_language
        IMPORTING output = lv_language
        EXCEPTIONS OTHERS = 1.
      IF sy-subrc <> 0 OR lv_language <> iv_language.
        RAISE EXCEPTION TYPE cx_ssf_fb.
      ENDIF.
    ENDIF.
    me->xml_init( ).
    me->xml_upload(
      EXPORTING dom = lo_root formname = iv_name
        language = iv_language
      CHANGING sform = lo_result ).
    IF lo_result <> me OR me->varheader IS INITIAL
       OR me->header-formtype <> cssf_formtype_complete.
      RAISE EXCEPTION TYPE cx_ssf_fb.
    ENDIF.
    LOOP AT me->varheader INTO ls_variant.
      IF ls_variant-pagetree IS INITIAL.
        RAISE EXCEPTION TYPE cx_ssf_fb.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD execute.
    DATA lo_form TYPE REF TO zcl_orvanta_smartform.
    DATA lo_read TYPE REF TO zcl_orvanta_smartform.
    DATA lx_error TYPE REF TO cx_root.
    DATA ls_adm TYPE stxfadm.
    DATA ls_tadir TYPE tadir.
    DATA ls_request TYPE e070.
    DATA lv_name TYPE tdsfname.
    DATA lv_language TYPE sylangu.
    DATA lv_package TYPE devclass.
    DATA lv_request TYPE trkorr.
    DATA lv_activity TYPE c LENGTH 2.
    DATA lv_exists TYPE c LENGTH 1.
    DATA lv_locked TYPE c LENGTH 1.
    DATA lv_write TYPE c LENGTH 1.
    DATA lv_touched TYPE c LENGTH 1.
    DATA lv_active TYPE tdbool.
    DATA lv_inactive TYPE tdbool.
    DATA lv_load_active TYPE tdsfflag.
    DATA lv_hash TYPE string.
    DATA lv_before TYPE string.
    DATA lv_after TYPE string.
    DATA lv_rc TYPE i.
    DATA lv_devclass TYPE devclass.
    DATA lv_saved_hash TYPE string.
    DATA lv_fmnumber TYPE tdfmnumb.
    CLEAR: ev_status, ev_code, ev_message, ev_xml,
      ev_fingerprint, ev_package, ev_active, ev_inactive,
      ev_request.
    ev_protocol = '1'.
    ev_status = 'E'.
    ev_code = 'INVALID_INPUT'.
    ev_formname = iv_formname.
    ev_language = iv_language.
    ev_version = iv_version.
    TRY.
      IF iv_action <> 'READ' AND iv_action <> 'CREATE'
         AND iv_action <> 'SAVE' AND iv_action <> 'ACTIVATE'.
        RAISE EXCEPTION TYPE cx_ssf_fb.
      ENDIF.
      IF iv_action = 'READ'.
        FIND REGEX
          '^([A-Z][A-Z0-9_]*|/[A-Z0-9_]+/[A-Z][A-Z0-9_]*)$'
          IN iv_formname.
      ELSE.
        FIND REGEX '^[ZY][A-Z0-9_]{0,29}$' IN iv_formname.
      ENDIF.
      IF sy-subrc <> 0 OR strlen( iv_formname ) > 30
         OR strlen( iv_language ) <> 1
         OR ( iv_version <> 'active' AND iv_version <> 'saved' ).
        RAISE EXCEPTION TYPE cx_ssf_fb.
      ENDIF.
      lv_name = iv_formname.
      lv_language = iv_language.
      SELECT SINGLE spras FROM t002 INTO lv_language
        WHERE spras = lv_language.
      IF sy-subrc <> 0.
        RAISE EXCEPTION TYPE cx_ssf_fb.
      ENDIF.
      IF iv_action <> 'READ'.
        lv_write = 'X'.
        IF ( iv_action = 'ACTIVATE' AND iv_version <> 'active' )
           OR ( iv_action <> 'ACTIVATE'
                AND iv_version <> 'saved' ).
          RAISE EXCEPTION TYPE cx_ssf_fb.
        ENDIF.
        FIND REGEX '^(\$TMP|[ZY][A-Z0-9_]{0,29})$'
          IN iv_package.
        IF sy-subrc <> 0.
          RAISE EXCEPTION TYPE cx_ssf_fb.
        ENDIF.
        lv_package = iv_package.
        SELECT SINGLE devclass FROM tdevc INTO lv_devclass
          WHERE devclass = lv_package.
        IF sy-subrc <> 0.
          RAISE EXCEPTION TYPE cx_ssf_fb.
        ENDIF.
        IF lv_package = '$TMP'.
          IF iv_transport IS NOT INITIAL.
            RAISE EXCEPTION TYPE cx_ssf_fb.
          ENDIF.
        ELSE.
          FIND REGEX '^[A-Z0-9]{3}K[0-9]{6}$'
            IN iv_transport.
          IF sy-subrc <> 0.
            RAISE EXCEPTION TYPE cx_ssf_fb.
          ENDIF.
          lv_request = iv_transport.
          SELECT SINGLE * FROM e070 INTO ls_request
            WHERE trkorr = lv_request.
* Require the user's existing modifiable development task.
          IF sy-subrc <> 0 OR ls_request-trstatus <> 'D'
             OR ls_request-trfunction <> 'S'
             OR ls_request-as4user <> sy-uname.
            RAISE EXCEPTION TYPE cx_ssf_fb.
          ENDIF.
        ENDIF.
        IF iv_action = 'CREATE'.
          IF iv_expected IS NOT INITIAL.
            RAISE EXCEPTION TYPE cx_ssf_fb.
          ENDIF.
        ELSE.
          FIND REGEX '^[a-f0-9]{64}$' IN iv_expected.
          IF sy-subrc <> 0.
            RAISE EXCEPTION TYPE cx_ssf_fb.
          ENDIF.
        ENDIF.
        IF iv_action = 'ACTIVATE'.
          IF iv_xml IS NOT INITIAL.
            RAISE EXCEPTION TYPE cx_ssf_fb.
          ENDIF.
        ELSEIF iv_xml IS INITIAL.
          RAISE EXCEPTION TYPE cx_ssf_fb.
        ENDIF.
      ELSEIF iv_xml IS NOT INITIAL OR iv_expected IS NOT INITIAL
         OR iv_package IS NOT INITIAL OR iv_transport IS NOT INITIAL.
        RAISE EXCEPTION TYPE cx_ssf_fb.
      ENDIF.

      ev_code = 'LOCK_FAILED'.
      CALL FUNCTION 'ENQUEUE_E_SMFORM'
        EXPORTING formname = lv_name _scope = '1'
        EXCEPTIONS OTHERS = 1.
      IF sy-subrc <> 0.
        RAISE EXCEPTION TYPE cx_ssf_fb.
      ENDIF.
      lv_locked = 'X'.
      SELECT SINGLE * FROM stxfadm INTO ls_adm
        WHERE formname = lv_name.
      IF sy-subrc = 0.
        lv_exists = 'X'.
      ENDIF.
      SELECT SINGLE * FROM tadir INTO ls_tadir
        WHERE pgmid = 'R3TR' AND object = 'SSFO'
          AND obj_name = lv_name.
      IF lv_exists = 'X'.
        IF sy-subrc <> 0 OR ls_tadir-devclass <> ls_adm-devclass.
          ev_code = 'REPOSITORY_INCONSISTENT'.
          RAISE EXCEPTION TYPE cx_ssf_fb.
        ENDIF.
        IF lv_write = 'X' AND lv_package <> ls_tadir-devclass.
          ev_code = 'PACKAGE_MISMATCH'.
          RAISE EXCEPTION TYPE cx_ssf_fb.
        ENDIF.
        lv_package = ls_tadir-devclass.
      ELSEIF sy-subrc = 0.
        ev_code = 'REPOSITORY_INCONSISTENT'.
        RAISE EXCEPTION TYPE cx_ssf_fb.
      ENDIF.
      ev_package = lv_package.
      lv_activity = '03'.
      IF lv_write = 'X'. lv_activity = '02'. ENDIF.
      IF iv_action = 'CREATE'. lv_activity = '01'. ENDIF.
      ev_code = 'NOT_AUTHORIZED'.
      AUTHORITY-CHECK OBJECT 'S_DEVELOP'
        ID 'DEVCLASS' FIELD lv_package ID 'OBJTYPE' FIELD 'SSFO'
        ID 'OBJNAME' FIELD lv_name ID 'P_GROUP' DUMMY
        ID 'ACTVT' FIELD lv_activity.
      IF sy-subrc <> 0. RAISE EXCEPTION TYPE cx_ssf_fb. ENDIF.
      IF iv_action = 'ACTIVATE'.
        AUTHORITY-CHECK OBJECT 'S_DEVELOP'
          ID 'DEVCLASS' FIELD lv_package ID 'OBJTYPE' FIELD 'SSFO'
          ID 'OBJNAME' FIELD lv_name ID 'P_GROUP' DUMMY
          ID 'ACTVT' FIELD '07'.
        IF sy-subrc <> 0. RAISE EXCEPTION TYPE cx_ssf_fb. ENDIF.
      ENDIF.
      IF iv_action = 'CREATE' AND lv_exists = 'X'.
        ev_code = 'ALREADY_EXISTS'.
        RAISE EXCEPTION TYPE cx_ssf_fb.
      ELSEIF iv_action <> 'CREATE' AND lv_exists IS INITIAL.
        ev_code = 'NOT_FOUND'.
        ev_message = 'Smart Form does not exist'.
        RAISE EXCEPTION TYPE cx_ssf_fb.
      ENDIF.
      IF lv_exists = 'X'.
        IF ls_adm-formtype <> cssf_formtype_complete.
          ev_code = 'UNSUPPORTED_FORM_TYPE'.
          RAISE EXCEPTION TYPE cx_ssf_fb.
        ENDIF.
        IF lv_write = 'X' AND ls_adm-masterlang <> lv_language.
          ev_code = 'MASTER_LANGUAGE_REQUIRED'.
          RAISE EXCEPTION TYPE cx_ssf_fb.
        ENDIF.
        ev_code = 'SNAPSHOT_FAILED'.
        lv_hash = snapshot( lv_name ).
        IF lv_write = 'X' AND lv_hash <> iv_expected.
          ev_code = 'STALE_FINGERPRINT'.
          RAISE EXCEPTION TYPE cx_ssf_fb.
        ENDIF.
      ENDIF.
      CREATE OBJECT lo_form.
* Authorization and E_SMFORM already checked; avoid GUI permission path.
      lo_form->enqueued = c_mode_display.
      IF iv_action = 'READ' OR iv_action = 'ACTIVATE'.
        ev_code = 'LOAD_FAILED'.
        IF iv_action = 'READ' AND iv_version = 'active'.
          lv_load_active = 'X'.
        ENDIF.
        lo_form->load( im_formname = lv_name
          im_language = lv_language im_active = lv_load_active ).
      ELSE.
        ev_code = 'XML_INVALID'.
        lo_form->upload( iv_xml = iv_xml iv_name = lv_name
                        iv_language = lv_language ).
      ENDIF.
      IF lv_write = 'X'.
        lo_form->enqueued = c_mode_edit.
        lo_form->korrnum = lv_request.
        lo_form->header-formname = lv_name.
        lo_form->header-devclass = lv_package.
        lo_form->header-masterlang = lv_language.
        lo_form->header-formtype = cssf_formtype_complete.
        lo_form->header-firstuser = sy-uname.
        lo_form->header-firstdate = sy-datum.
        lo_form->header-firsttime = sy-uzeit.
        IF lv_exists = 'X'.
          lo_form->header-firstuser = ls_adm-firstuser.
          lo_form->header-firstdate = ls_adm-firstdate.
          lo_form->header-firsttime = ls_adm-firsttime.
        ENDIF.
        lo_form->header-lastuser = sy-uname.
        lo_form->header-lastdate = sy-datum.
        lo_form->header-lasttime = sy-uzeit.
        lo_form->header-unchecked = 'X'.
        IF lv_exists = 'X'.
          lo_form->header-version = ls_adm-version.
        ENDIF.
        CLEAR lv_load_active.
        IF iv_action = 'ACTIVATE'.
          ev_code = 'CHECK_FAILED'.
          lo_form->check( global_check_flag = 'X' ).
          CLEAR lo_form->header-unchecked.
          lv_load_active = 'X'.
        ENDIF.
        ev_code = 'STORE_FAILED'.
        lv_touched = 'X'.
        lo_form->store( im_formname = lv_name
          im_language = lv_language im_active = lv_load_active ).
        lv_saved_hash = snapshot( lv_name ).
        IF iv_action = 'ACTIVATE'.
* Standard generation can commit and release locks internally.
* Any failure from this point is conservatively an unknown outcome.
          ev_code = 'GENERATION_FAILED'.
          CALL FUNCTION 'FB_GENERATE_FORM'
            EXPORTING i_formname = lv_name
            EXCEPTIONS OTHERS = 1.
          IF sy-subrc <> 0. RAISE EXCEPTION TYPE cx_ssf_fb. ENDIF.
          CALL FUNCTION 'SSF_READ_FMNUMBER'
            EXPORTING i_formname = lv_name
            IMPORTING o_fmnumb = lv_fmnumber.
          IF lv_fmnumber IS INITIAL.
            ev_code = 'GENERATED_NUMBER_MISSING'.
            RAISE EXCEPTION TYPE cx_ssf_fb.
          ENDIF.
* Reacquire for coherent readback; fail if another editor got the lock.
          CALL FUNCTION 'ENQUEUE_E_SMFORM'
            EXPORTING formname = lv_name _scope = '1'
            EXCEPTIONS OTHERS = 1.
          IF sy-subrc <> 0.
            ev_code = 'READBACK_LOCK_FAILED'.
            RAISE EXCEPTION TYPE cx_ssf_fb.
          ENDIF.
        ENDIF.
        ev_code = 'COMMIT_FAILED'.
        COMMIT WORK AND WAIT.
        IF sy-subrc <> 0. RAISE EXCEPTION TYPE cx_ssf_fb. ENDIF.
        ev_request = lv_request.
      ENDIF.
      ev_code = 'READBACK_FAILED'.
      lv_before = snapshot( lv_name ).
      IF lv_write = 'X' AND lv_before <> lv_saved_hash.
        RAISE EXCEPTION TYPE cx_ssf_fb.
      ENDIF.
      CREATE OBJECT lo_read.
      lo_read->enqueued = c_mode_display.
      CLEAR lv_load_active.
      IF iv_version = 'active'. lv_load_active = 'X'. ENDIF.
      lo_read->load( im_formname = lv_name
        im_language = lv_language im_active = lv_load_active ).
      ev_xml = lo_read->download( lv_language ).
      CALL FUNCTION 'SSF_STATUS_INFO'
        EXPORTING i_formname = lv_name
        IMPORTING o_active = lv_active o_inactive = lv_inactive.
      lv_after = snapshot( lv_name ).
      IF lv_before <> lv_after.
        RAISE EXCEPTION TYPE cx_ssf_fb.
      ENDIF.
      ev_fingerprint = lv_after.
      IF lv_active = 'X'. ev_active = 'X'. ENDIF.
      IF lv_inactive = 'X'. ev_inactive = 'X'. ENDIF.
      IF lv_write = 'X'.
        IF ( iv_action = 'ACTIVATE'
             AND ( lv_active IS INITIAL OR lv_inactive = 'X' ) )
           OR ( iv_action <> 'ACTIVATE' AND lv_inactive IS INITIAL ).
          RAISE EXCEPTION TYPE cx_ssf_fb.
        ENDIF.
      ENDIF.
      ev_status = 'S'.
      ev_code = 'OK'.
      ev_message = 'Smart Form operation and readback completed'.
    CATCH cx_root INTO lx_error.
      IF lv_write = 'X'. ROLLBACK WORK. ENDIF.
      IF ev_message IS INITIAL.
        ev_message = lx_error->get_text( ).
      ENDIF.
      IF lo_form IS BOUND AND
         lo_form->mv_transport_error IS NOT INITIAL.
        CONCATENATE ev_message lo_form->mv_transport_error
          INTO ev_message SEPARATED BY space.
      ENDIF.
      IF lv_touched = 'X'.
        CONCATENATE 'Outcome may be unknown; do not retry.'
          ev_code ev_message INTO ev_message SEPARATED BY space.
      ENDIF.
      CLEAR: ev_xml, ev_fingerprint.
    ENDTRY.
    IF lv_locked = 'X'.
      CALL FUNCTION 'DEQUEUE_E_SMFORM'
        EXPORTING formname = lv_name _scope = '1' _synchron = 'X'.
    ENDIF.
  ENDMETHOD.
ENDCLASS.
