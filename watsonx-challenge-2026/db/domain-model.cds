namespace com.bookshop;

entity Books {
    key ID  : String;
    title   : String(100);
    stock   : Integer;
    price   : Decimal(9,2);
}

entity Authors {
    key ID  : String;
    name    : String(100);
}